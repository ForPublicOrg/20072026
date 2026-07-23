import { existsSync } from "node:fs";
import path from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import open from "open";
import {
  MASTER_CSV,
  MEDIA_BUCKET,
  RESOURCES,
  ROOT,
  STATUSES,
  UPLOAD_BUCKET,
  appendUrlSubmissionToCsv,
  d1Execute,
  parseCsvRows,
  r2Get,
  writeCsvRows,
} from "../lib/admin-resources.mjs";
import { runUploadIngest } from "../lib/upload-ingest.mjs";
import { getCacheDir } from "../lib/review-cache.mjs";
import { spawnSync } from "node:child_process";
import { Header } from "./Header.mjs";
import { ListView } from "./ListView.mjs";
import { CsvListView, CSV_FILTER_CYCLE } from "./CsvListView.mjs";
import { UploadSelectView } from "./UploadSelectView.mjs";
import { DetailView } from "./DetailView.mjs";
import { ConfirmDialog } from "./ConfirmDialog.mjs";
import { suspendInk } from "./suspend.mjs";

const COLLECT_BATCH_PATH = path.join(ROOT, "scripts/collect-batch.mjs");
const FILTER_CYCLE = [null, ...STATUSES];

function WorkingScreen({ message, run }) {
  const called = useRef(false);
  useEffect(() => {
    if (called.current) return;
    called.current = true;
    // Defer past this render so the "message" actually paints before the
    // blocking spawnSync call underneath `run` freezes the event loop —
    // Node is single-threaded, so without this the message would never
    // visibly appear before the freeze.
    const t = setTimeout(run, 30);
    return () => clearTimeout(t);
  }, [run]);
  return React.createElement(Box, { padding: 1 }, React.createElement(Text, null, message));
}

function ResultScreen({ message, isError, onContinue }) {
  useInput(() => onContinue());
  return React.createElement(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: isError ? "red" : "green", padding: 1 },
    React.createElement(Text, { color: isError ? "red" : "green" }, message),
    React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, "press any key to continue")),
  );
}

function MenuScreen({ onChoose }) {
  const [index, setIndex] = useState(0);
  const options = [
    { label: "Video submissions", type: "video" },
    { label: "Takedown requests", type: "takedown" },
    { label: "Master CSV link queue (skip backlog rows)", type: "csv" },
    { label: "Run link ingestion (collect-batch.mjs)", type: "run-links" },
    { label: "Run raw-upload ingestion (select videos)", type: "run-uploads" },
  ];
  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j") setIndex((i) => Math.min(options.length - 1, i + 1));
    else if (key.return) onChoose(options[index].type);
    else if (input === "q") process.exit(0);
  });
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, "What would you like to review?"),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      options.map((opt, i) =>
        React.createElement(
          Text,
          { key: opt.type, color: i === index ? "cyan" : undefined, inverse: i === index },
          `${i === index ? "› " : "  "}${opt.label}`,
        ),
      ),
    ),
    React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true }, "↑/↓ move  enter select  q quit")),
  );
}

export function App({ env, authEmail, resumeState, onSuspend }) {
  const [screen, setScreen] = useState(resumeState?.screen ?? "menu");
  const [type, setType] = useState(resumeState?.type ?? null);
  const [statusFilter, setStatusFilter] = useState(resumeState?.statusFilter ?? null);
  const [rows, setRows] = useState([]);
  const [selectedRow, setSelectedRow] = useState(null);
  const [flow, setFlow] = useState(null);
  const [csvRows, setCsvRows] = useState([]);
  const [csvFilter, setCsvFilter] = useState("pending");
  const [uploadSelectRows, setUploadSelectRows] = useState([]);
  const [uploadSelectIds, setUploadSelectIds] = useState(new Set());

  function showResult(message, isError, onContinue) {
    setScreen("flow");
    setFlow({ kind: "result", message, isError, onContinue });
  }

  function showConfirm(title, message, onYes, onNo) {
    setScreen("flow");
    setFlow({ kind: "confirm", title, message, onYes, onNo });
  }

  function loadList(forType, forFilter) {
    setType(forType);
    setStatusFilter(forFilter);
    setScreen("flow");
    setFlow({
      kind: "working",
      message: `Loading ${forType} requests${forFilter ? ` (status: ${forFilter})` : ""}...`,
      run: () => {
        try {
          const resource = RESOURCES[forType];
          const database = resource.database(env);
          let sql = `SELECT * FROM ${resource.table}`;
          if (forFilter) sql += ` WHERE status = '${forFilter}'`;
          sql += " ORDER BY created_at DESC";
          setRows(d1Execute(database, sql));
          setScreen("list");
        } catch (err) {
          showResult(`Failed to load: ${err.message}`, true, () => setScreen("menu"));
        }
      },
    });
  }

  // Land directly in a fresh list after resuming from a suspended
  // collect-batch.mjs run — never restore a stale in-memory row set.
  useEffect(() => {
    if (resumeState?.screen === "list") {
      loadList(resumeState.type, resumeState.statusFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goDetail(row) {
    setSelectedRow(row);
    setScreen("detail");
  }

  function cycleFilter() {
    const idx = FILTER_CYCLE.indexOf(statusFilter);
    const next = FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length];
    loadList(type, next);
  }

  // Master CSV is a local file, not D1 — reading/writing it is synchronous
  // and near-instant, so unlike loadList there's no need to route this
  // through a WorkingScreen.
  function loadCsvRows(filter) {
    try {
      setCsvRows(parseCsvRows(MASTER_CSV));
      setCsvFilter(filter ?? csvFilter);
      setScreen("csv");
    } catch (err) {
      showResult(`Failed to read master CSV: ${err.message}`, true, () => setScreen("menu"));
    }
  }

  function cycleCsvFilter() {
    const idx = CSV_FILTER_CYCLE.indexOf(csvFilter);
    setCsvFilter(CSV_FILTER_CYCLE[(idx + 1) % CSV_FILTER_CYCLE.length]);
  }

  function handleToggleCsvIgnore(idx) {
    const row = csvRows[idx];
    // Never let this screen reclassify a row collect-batch.mjs already
    // resolved to "published" — only blank/failed/ignored are ours to touch.
    if (!row || row.status === "published") return;
    const next = csvRows.map((r) => ({ ...r }));
    const target = next[idx];
    if (target.status === "ignored") {
      target.status = "";
      target.notes = target.notes.replace(/\s*\(skipped via admin-tui\)/i, "").trim();
    } else {
      target.status = "ignored";
      target.notes = target.notes ? `${target.notes} (skipped via admin-tui)` : "skipped via admin-tui";
    }
    try {
      writeCsvRows(MASTER_CSV, next);
      setCsvRows(next);
    } catch (err) {
      showResult(`Failed to update master CSV: ${err.message}`, true, () => setScreen("csv"));
    }
  }

  function handleOpenCsvLink(link) {
    open(link).catch(() => {});
  }

  function handleReject(row) {
    const table = type === "video" ? "video_submissions" : "takedown_requests";
    showConfirm(
      "Reject",
      `Set ${type} #${row.id} to rejected. Continue?`,
      () => {
        setScreen("flow");
        setFlow({
          kind: "working",
          message: "Updating status...",
          run: () => {
            try {
              d1Execute(RESOURCES[type].database(env), `UPDATE ${table} SET status = 'rejected' WHERE id = ${row.id}`);
              showResult(`${type} #${row.id} -> rejected.`, false, () => loadList(type, statusFilter));
            } catch (err) {
              showResult(`Failed: ${err.message}`, true, () => setScreen("detail"));
            }
          },
        });
      },
      () => setScreen("detail"),
    );
  }

  function handleApproveTakedown(row) {
    showConfirm(
      "Approve",
      `Set takedown #${row.id} to approved (acknowledgment only — no content is removed automatically). Continue?`,
      () => {
        setScreen("flow");
        setFlow({
          kind: "working",
          message: "Updating status...",
          run: () => {
            try {
              d1Execute(RESOURCES.takedown.database(env), `UPDATE takedown_requests SET status = 'approved' WHERE id = ${row.id}`);
              showResult(`takedown #${row.id} -> approved.`, false, () => loadList("takedown", statusFilter));
            } catch (err) {
              showResult(`Failed: ${err.message}`, true, () => setScreen("detail"));
            }
          },
        });
      },
      () => setScreen("detail"),
    );
  }

  // Approving no longer triggers ingestion inline — the admin may be
  // batch-approving many rows in a row, and running the (slow, rate-limited
  // for links; transcode-heavy for uploads) ingestion pipeline after every
  // single approval both surprises them and risks kicking off a big backlog
  // run by accident. Ingestion is a separate, deliberate action from the
  // main menu ("Run link ingestion" / "Run raw-upload ingestion") once
  // they're done approving.
  function handleApproveVideoUrl(row) {
    showConfirm(
      "Approve",
      `Set video submission #${row.id} to approved, then append its URL to the master CSV. Continue?`,
      () => {
        setScreen("flow");
        setFlow({
          kind: "working",
          message: "Updating status and appending to CSV...",
          run: () => {
            try {
              const database = RESOURCES.video.database(env);
              d1Execute(database, `UPDATE video_submissions SET status = 'approved' WHERE id = ${row.id}`);
              const csvResult = appendUrlSubmissionToCsv(row, row.id);
              const csvMsg = csvResult.appended
                ? `Appended ${row.url} to ${path.basename(MASTER_CSV)}.`
                : csvResult.reason === "already-present"
                  ? `${row.url} was already in the master CSV.`
                  : "";
              showResult(
                `${csvMsg}\nApproved — queued. Run "Run link ingestion" from the main menu once you're done approving.`,
                false,
                () => loadList("video", statusFilter),
              );
            } catch (err) {
              showResult(`Failed: ${err.message}`, true, () => setScreen("detail"));
            }
          },
        });
      },
      () => setScreen("detail"),
    );
  }

  function handleApproveVideoUpload(row) {
    showConfirm(
      "Approve",
      `Set video submission #${row.id} to approved. Continue?`,
      () => {
        setScreen("flow");
        setFlow({
          kind: "working",
          message: "Updating status...",
          run: () => {
            try {
              d1Execute(RESOURCES.video.database(env), `UPDATE video_submissions SET status = 'approved' WHERE id = ${row.id}`);
              showResult(
                `Approved — queued. Run "Run raw-upload ingestion" from the main menu once you're done approving.`,
                false,
                () => loadList("video", statusFilter),
              );
            } catch (err) {
              showResult(`Failed: ${err.message}`, true, () => setScreen("detail"));
            }
          },
        });
      },
      () => setScreen("detail"),
    );
  }

  // Single-submission ingest (download-if-needed -> transcode -> thumbnail
  // -> upload to blackdays-media -> mark done), reused by the multi-select
  // batch runner below. Throws on failure — caller decides how to report it.
  function ingestUploadRow(row) {
    const ext = path.extname(row.r2_key || "") || ".mp4";
    const cachePath = path.join(getCacheDir(), `${row.id}${ext}`);
    if (!existsSync(cachePath)) {
      r2Get(UPLOAD_BUCKET(env), row.r2_key, cachePath, { quiet: true });
    }
    const ingestResult = runUploadIngest({ localFilePath: cachePath, submissionRow: row });
    d1Execute(RESOURCES.video.database(env), `UPDATE video_submissions SET status = 'done' WHERE id = ${row.id}`);
    return ingestResult;
  }

  function runLinkIngestion() {
    setScreen("flow");
    setFlow({
      kind: "working",
      message: "Checking master CSV backlog...",
      run: () => {
        try {
          const csvRowsNow = parseCsvRows(MASTER_CSV);
          const pendingCount = csvRowsNow.filter((r) => r.status === "" || r.status === "failed").length;
          if (pendingCount === 0) {
            showResult("No pending (blank/failed) rows in the master CSV.", false, () => setScreen("menu"));
            return;
          }
          setFlow({
            kind: "confirm",
            title: "Run link ingestion?",
            message:
              `This will attempt ${pendingCount} pending link(s) from the master CSV via collect-batch.mjs — ` +
              `the whole backlog, not just recently approved ones. Rate-limited (~20-40s between each). ` +
              `Use "Master CSV link queue" first to mark any you want skipped as ignored. Run now?`,
            onYes: () => {
              onSuspend({ screen: "menu" }, () => {
                console.log(`\nRunning: node ${path.relative(ROOT, COLLECT_BATCH_PATH)} "${MASTER_CSV}"\n`);
                spawnSync("node", [COLLECT_BATCH_PATH, MASTER_CSV], { cwd: ROOT, stdio: "inherit" });
              });
            },
            onNo: () => setScreen("menu"),
          });
        } catch (err) {
          showResult(`Failed: ${err.message}`, true, () => setScreen("menu"));
        }
      },
    });
  }

  function loadUploadSelect() {
    setScreen("flow");
    setFlow({
      kind: "working",
      message: "Loading approved raw uploads...",
      run: () => {
        try {
          const rows = d1Execute(
            RESOURCES.video.database(env),
            `SELECT * FROM video_submissions WHERE submission_type = 'upload' AND status = 'approved' ORDER BY created_at ASC`,
          );
          setUploadSelectRows(rows);
          setUploadSelectIds(new Set());
          setScreen("uploadSelect");
        } catch (err) {
          showResult(`Failed to load: ${err.message}`, true, () => setScreen("menu"));
        }
      },
    });
  }

  function toggleUploadSelect(id) {
    setUploadSelectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllUploadSelect() {
    setUploadSelectIds((prev) =>
      prev.size === uploadSelectRows.length ? new Set() : new Set(uploadSelectRows.map((r) => r.id)),
    );
  }

  function runSelectedUploadIngest() {
    const selected = uploadSelectRows.filter((r) => uploadSelectIds.has(r.id));
    if (selected.length === 0) {
      showResult("Select at least one row (space) or press 'a' for all first.", true, () => setScreen("uploadSelect"));
      return;
    }
    showConfirm(
      "Ingest selected uploads?",
      `Ingest ${selected.length} selected upload(s): download, transcode, thumbnail, upload to ${MEDIA_BUCKET}, ` +
        `draft videos.json entries. Runs serially and can take a while per video. Continue?`,
      () => {
        setScreen("flow");
        setFlow({
          kind: "working",
          message: `Ingesting ${selected.length} selected upload(s) — this can take a while...`,
          run: () => {
            const results = selected.map((row) => {
              try {
                const ingestResult = ingestUploadRow(row);
                return {
                  id: row.id,
                  ok: true,
                  videoId: ingestResult.id,
                  todoFields: ingestResult.todoFields,
                  contact: row.contact,
                };
              } catch (err) {
                return { id: row.id, ok: false, error: err.message };
              }
            });
            const succeeded = results.filter((r) => r.ok);
            const failed = results.filter((r) => !r.ok);
            const lines = [`Ingested ${succeeded.length}/${results.length} selected upload(s).`];
            for (const r of succeeded) {
              const contactLine = r.contact ? ` [contact: ${r.contact}]` : "";
              lines.push(`  #${r.id} -> ${r.videoId} (TODO: ${r.todoFields.join(", ")})${contactLine}`);
            }
            if (failed.length > 0) {
              lines.push('Failed (still "approved" — safe to retry from this screen):');
              for (const r of failed) lines.push(`  #${r.id}: ${r.error}`);
            }
            lines.push('Next: fill the TODOs in src/data/videos.json, run "npm run build" to validate, then commit/PR.');
            showResult(lines.join("\n"), failed.length > 0, () => setScreen("menu"));
          },
        });
      },
      () => setScreen("uploadSelect"),
    );
  }

  function handleOpen(row) {
    open(row.url).catch(() => {});
  }

  function handleDownloadAndOpen(row) {
    const ext = path.extname(row.r2_key || "") || ".mp4";
    const cachePath = path.join(getCacheDir(), `${row.id}${ext}`);
    const alreadyCached = existsSync(cachePath);
    setScreen("flow");
    setFlow({
      kind: "working",
      message: alreadyCached ? "Opening cached file..." : "Downloading...",
      run: () => {
        try {
          if (!alreadyCached) {
            r2Get(UPLOAD_BUCKET(env), row.r2_key, cachePath, { quiet: true });
          }
          open(cachePath).catch(() => {});
          setScreen("detail");
        } catch (err) {
          showResult(`Download failed: ${err.message}`, true, () => setScreen("detail"));
        }
      },
    });
  }

  let body;
  if (screen === "menu") {
    body = React.createElement(MenuScreen, {
      onChoose: (t) => {
        if (t === "csv") loadCsvRows("pending");
        else if (t === "run-links") runLinkIngestion();
        else if (t === "run-uploads") loadUploadSelect();
        else loadList(t, null);
      },
    });
  } else if (screen === "csv") {
    body = React.createElement(CsvListView, {
      rows: csvRows,
      filter: csvFilter,
      onToggleIgnore: handleToggleCsvIgnore,
      onCycleFilter: cycleCsvFilter,
      onOpen: handleOpenCsvLink,
      onRefresh: () => loadCsvRows(csvFilter),
      onBack: () => setScreen("menu"),
    });
  } else if (screen === "uploadSelect") {
    body = React.createElement(UploadSelectView, {
      rows: uploadSelectRows,
      selectedIds: uploadSelectIds,
      onToggle: toggleUploadSelect,
      onToggleAll: toggleAllUploadSelect,
      onRun: runSelectedUploadIngest,
      onRefresh: loadUploadSelect,
      onBack: () => setScreen("menu"),
    });
  } else if (screen === "list") {
    body = React.createElement(ListView, {
      rows,
      type,
      statusFilter,
      onSelect: goDetail,
      onCycleFilter: cycleFilter,
      onRefresh: () => loadList(type, statusFilter),
      onBack: () => setScreen("menu"),
    });
  } else if (screen === "detail") {
    body = React.createElement(DetailView, {
      row: selectedRow,
      type,
      onOpen: () => handleOpen(selectedRow),
      onDownloadOpen: () => handleDownloadAndOpen(selectedRow),
      onApprove: () =>
        type === "takedown"
          ? handleApproveTakedown(selectedRow)
          : selectedRow.submission_type === "upload"
            ? handleApproveVideoUpload(selectedRow)
            : handleApproveVideoUrl(selectedRow),
      onReject: () => handleReject(selectedRow),
      onBack: () => setScreen("list"),
    });
  } else if (screen === "flow" && flow?.kind === "working") {
    body = React.createElement(WorkingScreen, { message: flow.message, run: flow.run });
  } else if (screen === "flow" && flow?.kind === "confirm") {
    body = React.createElement(ConfirmDialog, {
      title: flow.title,
      message: flow.message,
      onYes: flow.onYes,
      onNo: flow.onNo,
    });
  } else if (screen === "flow" && flow?.kind === "result") {
    body = React.createElement(ResultScreen, {
      message: flow.message,
      isError: flow.isError,
      onContinue: flow.onContinue,
    });
  }

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Header, { env, authEmail }),
    body,
  );
}

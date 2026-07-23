import React from "react";
import { Box, Text, useInput } from "ink";

function Field({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value);
  // Submitted text (description/message) sometimes contains embedded
  // newlines (pasted social captions, etc.) — stack label above value for
  // anything long or multi-line rather than a side-by-side row, which
  // otherwise collides the label against the wrapped first line.
  const stacked = str.includes("\n") || str.length > 60;
  if (stacked) {
    return React.createElement(
      Box,
      { flexDirection: "column", marginBottom: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, `${label}:`),
      React.createElement(Text, null, str),
    );
  }
  return React.createElement(
    Box,
    null,
    React.createElement(Text, { bold: true, color: "cyan" }, `${label}: `),
    React.createElement(Text, null, str),
  );
}

export function DetailView({ row, type, onOpen, onDownloadOpen, onApprove, onReject, onBack }) {
  const isVideo = type === "video";
  const isUploadType = isVideo && row.submission_type === "upload";

  useInput((input, key) => {
    if (input === "o" && isVideo && !isUploadType) onOpen();
    else if (input === "d" && isUploadType) onDownloadOpen();
    else if (input === "a") onApprove();
    else if (input === "r" && !key.ctrl) onReject();
    else if (input === "b" || key.escape) onBack();
  });

  const actionHints = [];
  if (isVideo && !isUploadType) actionHints.push("[o] open link");
  if (isUploadType) actionHints.push("[d] download+open");
  actionHints.push("[a] approve", "[r] reject", "[b] back");

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, `${type === "video" ? "Video submission" : "Takedown request"} #${row.id}`),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      React.createElement(Field, { label: "status", value: row.status }),
      React.createElement(Field, { label: "created_at", value: row.created_at }),
      React.createElement(Field, { label: "ip_country", value: row.ip_country }),
      isVideo
        ? React.createElement(React.Fragment, null,
            React.createElement(Field, { label: "submission_type", value: row.submission_type }),
            React.createElement(Field, { label: "url", value: row.url }),
            React.createElement(Field, { label: "r2_key", value: row.r2_key }),
            React.createElement(Field, { label: "file_size_bytes", value: row.file_size_bytes }),
            React.createElement(Field, { label: "mime_type", value: row.mime_type }),
            React.createElement(Field, { label: "original_filename", value: row.original_filename }),
            React.createElement(Field, { label: "event_date", value: row.event_date }),
            React.createElement(Field, { label: "description", value: row.description }),
          )
        : React.createElement(React.Fragment, null,
            React.createElement(Field, { label: "kind", value: row.kind }),
            React.createElement(Field, { label: "entry_ref", value: row.entry_ref }),
            React.createElement(Field, { label: "message", value: row.message }),
          ),
      React.createElement(Field, { label: "contact", value: row.contact }),
      React.createElement(Text, { dimColor: true }, "(contact is shown here for follow-up only — never written to any file)"),
    ),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, actionHints.join("  ")),
    ),
  );
}

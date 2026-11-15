import type { Attachment } from "@examio/core";

/** Attached private files: a download link once the virus check passed, otherwise its state. */
export function FileList({ files }: { files: Attachment[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm" aria-label="Attached files">
      {files.map((f) => (
        <li key={f.fileId}>
          {f.status === "clean" ? (
            <a href={`/files/${f.fileId}`} className="text-brand-700 hover:underline">
              {f.name}
            </a>
          ) : (
            <span className="text-slate-700">
              {f.name} <span className="text-xs text-slate-500">{f.status === "quarantined" ? "(virus check pending)" : f.status === "rejected" ? "(blocked by the virus check)" : "(unavailable)"}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

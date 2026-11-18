"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ChoiceOption } from "@examio/core";
import { Button, cx } from "@/components/ui";
import { flagExamQuestionAction, saveExamAnswerAction, submitExamAction } from "../../actions";

type Response = { choice: string | null } | { value: boolean | null } | { text: string };

export interface RunnerItem {
  itemId: string;
  position: number;
  type: "single_choice" | "true_false" | "descriptive";
  stem: string;
  options: ChoiceOption[] | null;
  marks: string;
  negativeMarks: string | null;
  imageFileId: string | null;
  response: Response | null;
  revision: number;
  flagged: boolean;
}

type SaveState = { kind: "saved"; at: string } | { kind: "saving" } | { kind: "pending" } | { kind: "error"; message: string; retry: boolean };

const isAnswered = (r: Response | null | undefined) => {
  const x = r as { choice?: string | null; value?: boolean | null; text?: string } | null | undefined;
  return !!x && (x.choice != null || x.value != null || (x.text ?? "").trim() !== "");
};

const clock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
};

/**
 * Exam screen. The server's clock decides: the remaining time is computed from the deadline and
 * the server time sent with the page, and the server refuses anything after the deadline. Each
 * answer is saved straight away (written answers after a short pause) and shows "Saved" only
 * once the server has acknowledged it; failed saves are retried, including when the connection
 * comes back. A save from an out-of-date window is refused and the student is told to reload.
 * At zero the attempt is submitted with what was saved.
 */
export function ExamRunner({ attemptId, deadlineAt, serverNow, items }: { attemptId: string; deadlineAt: string; serverNow: string; items: RunnerItem[] }) {
  const offset = useRef(Date.parse(serverNow) - Date.now());
  const deadline = Date.parse(deadlineAt);
  const [now, setNow] = useState(() => Date.now() + offset.current);
  const [current, setCurrent] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [responses, setResponses] = useState<Record<string, Response | null>>(() => Object.fromEntries(items.map((i) => [i.itemId, i.response])));
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.itemId, i.flagged])));
  const [status, setStatus] = useState<Record<string, SaveState>>({});
  const [closed, setClosed] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const revisions = useRef<Record<string, number>>(Object.fromEntries(items.map((i) => [i.itemId, i.revision])));
  const latest = useRef<Record<string, Response | null>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const queue = useRef<Record<string, Promise<void>>>({});
  const autoSubmitted = useRef(false);

  const remaining = deadline - now;

  const save = useCallback(
    (itemId: string): Promise<void> => {
      const run = async () => {
        await queue.current[itemId];
        const response = latest.current[itemId];
        if (response === undefined) return;
        setStatus((s) => ({ ...s, [itemId]: { kind: "saving" } }));
        try {
          const r = await saveExamAnswerAction(attemptId, itemId, response, revisions.current[itemId] ?? 0);
          if (r.ok) {
            revisions.current[itemId] = r.revision;
            if (latest.current[itemId] === response) delete latest.current[itemId];
            setStatus((s) => ({ ...s, [itemId]: { kind: "saved", at: r.savedAt } }));
          } else {
            if (r.final) setClosed(r.message);
            setStatus((s) => ({ ...s, [itemId]: { kind: "error", message: r.message, retry: false } }));
          }
        } catch {
          setStatus((s) => ({ ...s, [itemId]: { kind: "error", message: "Not saved yet: no connection. It will be retried.", retry: true } }));
        }
      };
      const p = run();
      queue.current[itemId] = p;
      return p;
    },
    [attemptId],
  );

  const change = (itemId: string, response: Response, delay = 0) => {
    if (closed) return;
    setResponses((r) => ({ ...r, [itemId]: response }));
    latest.current[itemId] = response;
    clearTimeout(timers.current[itemId]);
    setStatus((s) => ({ ...s, [itemId]: { kind: "pending" } }));
    if (delay === 0) void save(itemId);
    else timers.current[itemId] = setTimeout(() => void save(itemId), delay);
  };

  const flushAll = useCallback(async () => {
    for (const [id, t] of Object.entries(timers.current)) {
      clearTimeout(t);
      delete timers.current[id];
    }
    await Promise.all(Object.keys(latest.current).map((id) => save(id)));
  }, [save]);

  const unsaved = Object.values(status).filter((s) => s.kind !== "saved" && !(s.kind === "error" && !s.retry)).length;

  // Timer from the server clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(t);
  }, []);

  // Retry failed saves every few seconds and as soon as the connection returns.
  useEffect(() => {
    const retry = () => {
      for (const [id, s] of Object.entries(status)) if (s.kind === "error" && s.retry) void save(id);
    };
    const t = setInterval(retry, 5000);
    window.addEventListener("online", retry);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", retry);
    };
  }, [status, save]);

  // Warn before leaving with answers the server has not acknowledged.
  useEffect(() => {
    if (unsaved === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const submit = useCallback(() => {
    setSubmitError(null);
    startSubmit(async () => {
      await flushAll();
      const r = await submitExamAction(attemptId);
      if (r && !r.ok) setSubmitError(r.message);
    });
  }, [attemptId, flushAll]);

  // Time up: submit what was saved.
  useEffect(() => {
    if (remaining <= 0 && !autoSubmitted.current) {
      autoSubmitted.current = true;
      setClosed("Time is up. Your saved answers are being submitted.");
      submit();
    }
  }, [remaining, submit]);

  const toggleFlag = async (itemId: string) => {
    const next = !flags[itemId];
    setFlags((f) => ({ ...f, [itemId]: next }));
    const r = await flagExamQuestionAction(attemptId, itemId, next).catch(() => ({ ok: false as const, message: "No connection: the mark was not saved." }));
    if (!r.ok) {
      setFlags((f) => ({ ...f, [itemId]: !next }));
      setStatus((s) => ({ ...s, [itemId]: { kind: "error", message: r.message ?? "The mark was not saved.", retry: false } }));
    }
  };

  const answeredCount = items.filter((i) => isAnswered(responses[i.itemId])).length;
  const unanswered = useMemo(() => items.filter((i) => !isAnswered(responses[i.itemId])), [items, responses]);
  const flagged = items.filter((i) => flags[i.itemId]);
  const item = items[current]!;
  const st = status[item.itemId];
  const r = responses[item.itemId] as { choice?: string | null; value?: boolean | null; text?: string } | null;
  const name = `q-${item.itemId}`;

  return (
    <div className="space-y-4">
      <div className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200 lg:top-2">
        <p className={cx("text-lg font-semibold tabular-nums", remaining < 5 * 60_000 ? "text-red-700" : "text-slate-900")} role="timer" aria-live="off">
          <span className="sr-only">Time left: </span>
          {clock(remaining)}
        </p>
        <p className="text-sm text-slate-600">
          {answeredCount} of {items.length} answered{flagged.length ? ` · ${flagged.length} marked for review` : ""}
        </p>
        <p aria-live="polite" className={cx("text-sm", unsaved ? "text-amber-700" : "text-emerald-700")}>
          {unsaved ? `${unsaved} answer(s) not saved yet` : "All answers saved"}
        </p>
        {remaining > 0 && remaining < 5 * 60_000 && (
          <p role="status" className="w-full text-sm font-medium text-red-700">
            Less than 5 minutes left.
          </p>
        )}
      </div>

      {closed && (
        <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {closed}
        </p>
      )}

      <nav aria-label="Questions" className="flex flex-wrap gap-2">
        {items.map((i, n) => {
          const done = isAnswered(responses[i.itemId]);
          return (
            <button
              key={i.itemId}
              type="button"
              onClick={() => {
                setReviewing(false);
                setCurrent(n);
              }}
              aria-current={!reviewing && n === current ? "step" : undefined}
              aria-label={`Question ${i.position}${done ? ", answered" : ", not answered"}${flags[i.itemId] ? ", marked for review" : ""}`}
              className={cx(
                "relative flex size-10 items-center justify-center rounded-md text-sm font-semibold ring-1 ring-inset",
                !reviewing && n === current ? "ring-2 ring-brand-600" : "ring-slate-300",
                done ? "bg-brand-50 text-brand-800" : "bg-white text-slate-700",
              )}
            >
              {i.position}
              {flags[i.itemId] && <span aria-hidden className="absolute -right-1 -top-1 size-3 rounded-full bg-amber-500" />}
            </button>
          );
        })}
        <Button type="button" variant="secondary" onClick={() => setReviewing(true)} aria-current={reviewing ? "step" : undefined}>
          Review and submit
        </Button>
      </nav>

      {reviewing ? (
        <section aria-labelledby="review-h" className="space-y-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 id="review-h" className="text-base font-semibold text-slate-900">
            Review before submitting
          </h2>
          <p className="text-sm text-slate-700">
            {answeredCount} of {items.length} questions answered.
          </p>
          {unanswered.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-slate-900">Not answered:</p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {unanswered.map((i) => (
                  <li key={i.itemId}>
                    <button type="button" className="text-brand-700 underline" onClick={() => { setReviewing(false); setCurrent(items.indexOf(i)); }}>
                      Question {i.position}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {flagged.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-slate-900">Marked for review:</p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {flagged.map((i) => (
                  <li key={i.itemId}>
                    <button type="button" className="text-brand-700 underline" onClick={() => { setReviewing(false); setCurrent(items.indexOf(i)); }}>
                      Question {i.position}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unsaved > 0 && <p className="text-sm text-amber-800">{unsaved} answer(s) are still being saved; submitting waits for them.</p>}
          <p className="text-sm text-slate-600">After submitting you cannot change your answers.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={submit} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit exam"}
            </Button>
            {submitError && (
              <p role="alert" className="text-sm text-red-700">
                {submitError}
              </p>
            )}
          </div>
        </section>
      ) : (
        <section aria-labelledby="q-h" className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <fieldset disabled={!!closed}>
            <legend id="q-h" className="mb-3 w-full">
              <span className="text-sm font-semibold text-slate-900">
                Question {item.position} of {items.length}
              </span>{" "}
              <span className="text-xs text-slate-500">
                {item.marks} mark(s){item.negativeMarks ? `, −${item.negativeMarks} if wrong` : ""}
              </span>
              <span className="mt-2 block whitespace-pre-wrap text-base text-slate-900">{item.stem}</span>
            </legend>
            {item.imageFileId && <img src={`/files/${item.imageFileId}`} alt={`Figure for question ${item.position}`} className="mb-3 max-h-72 rounded border border-slate-200" />}
            {item.type === "single_choice" && (
              <div className="space-y-2">
                {item.options!.map((o) => (
                  <label key={o.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                    <input type="radio" name={name} checked={r?.choice === o.id} onChange={() => change(item.itemId, { choice: o.id })} className="mt-0.5" />
                    <span>
                      <span className="font-semibold text-slate-500">{o.id.toUpperCase()}.</span> {o.text}
                    </span>
                  </label>
                ))}
                {r?.choice != null && (
                  <button type="button" className="text-xs text-slate-600 underline" onClick={() => change(item.itemId, { choice: null })}>
                    Clear answer
                  </button>
                )}
              </div>
            )}
            {item.type === "true_false" && (
              <div className="flex flex-wrap gap-3">
                {[true, false].map((v) => (
                  <label key={String(v)} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                    <input type="radio" name={name} checked={r?.value === v} onChange={() => change(item.itemId, { value: v })} />
                    {v ? "True" : "False"}
                  </label>
                ))}
              </div>
            )}
            {item.type === "descriptive" && (
              <>
                <label htmlFor={name} className="sr-only">
                  Your answer to question {item.position}
                </label>
                <textarea
                  id={name}
                  rows={8}
                  maxLength={5000}
                  value={r?.text ?? ""}
                  onChange={(e) => change(item.itemId, { text: e.target.value }, 1000)}
                  onBlur={() => {
                    if (timers.current[item.itemId]) {
                      clearTimeout(timers.current[item.itemId]);
                      delete timers.current[item.itemId];
                      void save(item.itemId);
                    }
                  }}
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                />
              </>
            )}
          </fieldset>
          <p aria-live="polite" className={cx("mt-3 text-xs", st?.kind === "error" ? "text-red-700" : "text-slate-500")}>
            {st?.kind === "saving" || st?.kind === "pending" ? "Saving…" : st?.kind === "saved" ? `Saved ${new Date(st.at).toLocaleTimeString("en-IN")}` : st?.kind === "error" ? st.message : ""}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
              Previous
            </Button>
            {current < items.length - 1 ? (
              <Button type="button" variant="secondary" onClick={() => setCurrent((c) => c + 1)}>
                Next
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => setReviewing(true)}>
                Review and submit
              </Button>
            )}
            <Button type="button" variant="ghost" disabled={!!closed} aria-pressed={!!flags[item.itemId]} onClick={() => void toggleFlag(item.itemId)}>
              {flags[item.itemId] ? "Unmark review" : "Mark for review"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

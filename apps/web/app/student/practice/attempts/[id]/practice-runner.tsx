"use client";

import { useRef, useState, useTransition } from "react";
import type { ChoiceOption } from "@examio/core";
import { Button } from "@/components/ui";
import { savePracticeAnswerAction, submitPracticeAttemptAction } from "../../actions";

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
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * Answers one question at a time and saves each change straight away (written answers after a
 * short pause or on leaving the box). Every save carries the revision this screen last saw, so
 * a newer answer saved from another window is never overwritten: the screen asks to reload.
 */
export function PracticeRunner({ attemptId, items }: { attemptId: string; items: RunnerItem[] }) {
  const [responses, setResponses] = useState<Record<string, Response | null>>(() => Object.fromEntries(items.map((i) => [i.itemId, i.response])));
  const revisions = useRef<Record<string, number>>(Object.fromEntries(items.map((i) => [i.itemId, i.revision])));
  const [status, setStatus] = useState<Record<string, SaveState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const inFlight = useRef<Record<string, Promise<void>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();

  const save = (itemId: string, response: Response) => {
    const run = async () => {
      await inFlight.current[itemId];
      setStatus((s) => ({ ...s, [itemId]: { kind: "saving" } }));
      try {
        const r = await savePracticeAnswerAction(attemptId, itemId, response, revisions.current[itemId] ?? 0);
        if (r.ok) {
          revisions.current[itemId] = r.revision;
          setStatus((s) => ({ ...s, [itemId]: { kind: "saved" } }));
        } else {
          setStatus((s) => ({ ...s, [itemId]: { kind: "error", message: r.message } }));
        }
      } catch {
        setStatus((s) => ({ ...s, [itemId]: { kind: "error", message: "Not saved: check your connection and try again." } }));
      }
    };
    const p = run();
    inFlight.current[itemId] = p;
    return p;
  };

  const change = (itemId: string, response: Response, delay = 0) => {
    setResponses((r) => ({ ...r, [itemId]: response }));
    clearTimeout(timers.current[itemId]);
    if (delay === 0) void save(itemId, response);
    else {
      setStatus((s) => ({ ...s, [itemId]: { kind: "idle" } }));
      timers.current[itemId] = setTimeout(() => void save(itemId, response), delay);
    }
  };

  const flush = (itemId: string) => {
    if (timers.current[itemId]) {
      clearTimeout(timers.current[itemId]);
      delete timers.current[itemId];
      const r = responses[itemId];
      if (r) void save(itemId, r);
    }
  };

  const answered = items.filter((i) => {
    const r = responses[i.itemId] as { choice?: string | null; value?: boolean | null; text?: string } | null;
    return r && (r.choice != null || r.value != null || (r.text ?? "").trim() !== "");
  }).length;

  const submit = () => {
    setSubmitError(null);
    const unanswered = items.length - answered;
    if (!window.confirm(unanswered > 0 ? `${unanswered} question(s) are not answered. Submit anyway? You cannot change answers afterwards.` : "Submit your answers? You cannot change them afterwards.")) return;
    startSubmit(async () => {
      for (const id of Object.keys(timers.current)) flush(id);
      await Promise.all(Object.values(inFlight.current));
      const r = await submitPracticeAttemptAction(attemptId);
      if (r && !r.ok) setSubmitError(r.message);
    });
  };

  return (
    <div className="space-y-4">
      <ol className="space-y-4">
        {items.map((i) => {
          const r = responses[i.itemId] as { choice?: string | null; value?: boolean | null; text?: string } | null;
          const st = status[i.itemId] ?? { kind: "idle" };
          const name = `q-${i.itemId}`;
          return (
            <li key={i.itemId} className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
              <fieldset>
                <legend className="mb-2 w-full">
                  <span className="font-medium text-slate-900">Question {i.position}</span>{" "}
                  <span className="text-xs text-slate-500">
                    {i.marks} mark(s){i.negativeMarks ? `, −${i.negativeMarks} if wrong` : ""}
                    {i.type === "descriptive" ? " · not scored in practice" : ""}
                  </span>
                  <span className="mt-1 block whitespace-pre-wrap text-slate-900">{i.stem}</span>
                </legend>
                {i.imageFileId && <img src={`/files/${i.imageFileId}`} alt={`Figure for question ${i.position}`} className="mb-3 max-h-64 rounded border border-slate-200" />}
                {i.type === "single_choice" && (
                  <div className="space-y-2">
                    {i.options!.map((o) => (
                      <label key={o.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-slate-200 px-3 py-2 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                        <input type="radio" name={name} value={o.id} checked={r?.choice === o.id} onChange={() => change(i.itemId, { choice: o.id })} className="mt-0.5" />
                        <span>
                          <span className="font-semibold text-slate-500">{o.id.toUpperCase()}.</span> {o.text}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {i.type === "true_false" && (
                  <div className="flex gap-3">
                    {[true, false].map((v) => (
                      <label key={String(v)} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-4 py-2 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                        <input type="radio" name={name} checked={r?.value === v} onChange={() => change(i.itemId, { value: v })} />
                        {v ? "True" : "False"}
                      </label>
                    ))}
                  </div>
                )}
                {i.type === "descriptive" && (
                  <>
                    <label htmlFor={name} className="sr-only">
                      Your answer to question {i.position}
                    </label>
                    <textarea
                      id={name}
                      rows={4}
                      maxLength={5000}
                      value={r?.text ?? ""}
                      onChange={(e) => change(i.itemId, { text: e.target.value }, 1000)}
                      onBlur={() => flush(i.itemId)}
                      className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    />
                  </>
                )}
              </fieldset>
              <p aria-live="polite" className={st.kind === "error" ? "mt-2 text-xs text-red-700" : "mt-2 text-xs text-slate-500"}>
                {st.kind === "saving" ? "Saving…" : st.kind === "saved" ? "Saved" : st.kind === "error" ? st.message : ""}
              </p>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={submit} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit answers"}
        </Button>
        <span className="text-sm text-slate-600">
          {answered} of {items.length} answered
        </span>
        {submitError && (
          <p role="alert" className="text-sm text-red-700">
            {submitError}
          </p>
        )}
      </div>
    </div>
  );
}

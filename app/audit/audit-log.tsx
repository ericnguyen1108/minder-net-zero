"use client";

import { FormEvent, useEffect, useState } from "react";
import { platformFetch } from "../platform-client.ts";

type AuditEvent = { id: string; createdAt: string; actorName: string; actorEmail: string; actorRole: string; action: string; resourceType: string; resourceLabel: string; reason: string | null; requestId: string; outcome: "success" | "denied" | "failed"; chainVerified: boolean };

export default function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");

  async function load(params = "", append = false) { setState("loading"); try { const body = await platformFetch<{ events: AuditEvent[]; nextCursor: string | null }>(`/api/platform/audit${params ? `?${params}` : ""}`); setEvents((current) => append ? [...current, ...body.events] : body.events); setNextCursor(body.nextCursor); setState("ready"); } catch (error) { setMessage(error instanceof Error ? error.message : "Audit history is unavailable."); setState("error"); } }
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, []);
  function filter(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const query = new URLSearchParams(); for (const key of ["action", "actor", "from", "to"]) { const value = String(data.get(key) ?? "").trim(); if (value) query.set(key, value); } void load(query.toString()); }

  return <section className="platform-card audit-card"><form className="audit-filters" onSubmit={filter}><label>Action<input name="action" placeholder="For example, review.submitted" /></label><label>Person<input name="actor" placeholder="Name or email" /></label><label>From<input name="from" type="date" /></label><label>To<input name="to" type="date" /></label><button className="platform-secondary">Filter</button></form>{state === "error" ? <p className="platform-error" role="alert">{message}</p> : null}<div className="audit-table-wrap"><table className="audit-table"><thead><tr><th>Time</th><th>Person</th><th>Action</th><th>Record</th><th>Result</th><th>Integrity</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></td><td><strong>{event.actorName}</strong><small>{event.actorEmail} · {event.actorRole.replaceAll("_", " ")}</small></td><td><code>{event.action}</code>{event.reason ? <small>{event.reason}</small> : null}</td><td>{event.resourceLabel || event.resourceType}<small>{event.requestId}</small></td><td><span className={`audit-outcome audit-outcome-${event.outcome}`}>{event.outcome}</span></td><td>{event.chainVerified ? <span className="audit-verified">✓ Verified</span> : <span className="audit-warning">Check</span>}</td></tr>)}{state === "loading" && events.length === 0 ? <tr><td colSpan={6}>Loading the central history…</td></tr> : null}{state === "ready" && events.length === 0 ? <tr><td colSpan={6}>No events match these filters.</td></tr> : null}</tbody></table></div>{nextCursor ? <button className="platform-secondary audit-more" type="button" onClick={() => void load(`cursor=${encodeURIComponent(nextCursor)}`, true)}>Load older events</button> : null}</section>;
}

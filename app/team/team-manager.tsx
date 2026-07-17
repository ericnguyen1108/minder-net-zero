"use client";

import { FormEvent, useEffect, useState } from "react";
import { platformFetch, ROLE_OPTIONS, type CompetitionRole } from "../platform-client.ts";

type Competition = { id: string; name: string; roles: CompetitionRole[] };
type Member = {
  id: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  roles: CompetitionRole[];
  lastActiveAt: string | null;
};
type Invitation = { id: string; email: string; roles: CompetitionRole[]; status: string; createdAt: string };

export default function TeamManager() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [competitionId, setCompetitionId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState<CompetitionRole[]>(["reviewer"]);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void platformFetch<{ competitions: Competition[]; activeCompetitionId?: string }>("/api/platform/context")
      .then((body) => {
        setCompetitions(body.competitions);
        setCompetitionId(body.activeCompetitionId ?? body.competitions[0]?.id ?? "");
      })
      .catch((error: Error) => { setMessage(error.message); setState("error"); });
  }, []);

  useEffect(() => {
    if (!competitionId) return;
    const initial = window.setTimeout(() => {
      setState("loading");
      void platformFetch<{ members: Member[]; invitations: Invitation[] }>(`/api/platform/members?competitionId=${encodeURIComponent(competitionId)}`)
        .then((body) => { setMembers(body.members); setInvitations(body.invitations); setState("ready"); })
        .catch((error: Error) => { setMessage(error.message); setState("error"); });
    }, 0);
    return () => window.clearTimeout(initial);
  }, [competitionId]);

  function toggleRole(role: CompetitionRole) {
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!competitionId || !email.trim() || roles.length === 0) return;
    setState("saving");
    setMessage("");
    try {
      const body = await platformFetch<{ invitation: Invitation }>("/api/platform/members", {
        method: "POST",
        body: JSON.stringify({ competitionId, email: email.trim(), roles }),
      });
      setInvitations((current) => [body.invitation, ...current.filter((item) => item.id !== body.invitation.id)]);
      setEmail("");
      setRoles(["reviewer"]);
      setMessage("Invitation sent. Access will activate only after the person accepts it.");
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invitation could not be sent.");
      setState("error");
    }
  }

  async function updateMember(member: Member, nextRoles: CompetitionRole[]) {
    if (nextRoles.length === 0) return;
    setState("saving");
    try {
      const body = await platformFetch<{ member: Member }>("/api/platform/members", {
        method: "PATCH",
        body: JSON.stringify({ competitionId, userId: member.id, roles: nextRoles }),
      });
      setMembers((current) => current.map((item) => item.id === body.member.id ? body.member : item));
      setMessage(`Access updated for ${body.member.name || body.member.email}.`);
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Access could not be updated.");
      setState("error");
    }
  }

  return (
    <div className="team-layout">
      <section className="platform-card invite-card">
        <div className="platform-card-heading"><div><p className="eyebrow">Invite a person</p><h2>Send secure access</h2></div><span>Invitation only</span></div>
        <form onSubmit={invite}>
          <label>Competition<select value={competitionId} onChange={(event) => setCompetitionId(event.target.value)} required>{competitions.map((competition) => <option key={competition.id} value={competition.id}>{competition.name}</option>)}</select></label>
          <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="reviewer@example.org" required /></label>
          <fieldset><legend>What can this person do?</legend>{ROLE_OPTIONS.map((role) => <label className="role-choice" key={role.value}><input type="checkbox" checked={roles.includes(role.value)} onChange={() => toggleRole(role.value)} /><span><strong>{role.label}</strong><small>{role.description}</small></span></label>)}</fieldset>
          <button className="platform-primary" disabled={state === "saving" || !competitionId || !email.trim() || roles.length === 0}>{state === "saving" ? "Saving…" : "Send invitation"}</button>
          {message ? <p className={state === "error" ? "platform-error" : "platform-success"} role="status">{message}</p> : null}
        </form>
      </section>

      <section className="platform-card member-card">
        <div className="platform-card-heading"><div><p className="eyebrow">Current access</p><h2>People and roles</h2></div><span>{members.length} active</span></div>
        {state === "loading" ? <p className="platform-muted">Loading the shared team…</p> : members.length === 0 ? <div className="platform-empty"><strong>No members yet</strong><p>Invite the first reviewer when the competition is ready.</p></div> : <div className="member-list">{members.map((member) => <article key={member.id}><div className="member-identity"><span>{(member.name || member.email).slice(0, 1).toUpperCase()}</span><div><strong>{member.name || "Invited member"}</strong><small>{member.email}</small></div></div><div className="member-role-grid">{ROLE_OPTIONS.map((role) => <label key={role.value}><input type="checkbox" checked={member.roles.includes(role.value)} disabled={state === "saving"} onChange={() => void updateMember(member, member.roles.includes(role.value) ? member.roles.filter((item) => item !== role.value) : [...member.roles, role.value])} />{role.label}</label>)}</div><span className={`member-status member-status-${member.status}`}>{member.status}</span></article>)}</div>}
        {invitations.length > 0 ? <div className="pending-invitations"><h3>Pending invitations</h3>{invitations.map((invitation) => <div key={invitation.id}><span>{invitation.email}</span><small>{invitation.roles.map((role) => ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role).join(", ")}</small></div>)}</div> : null}
      </section>
    </div>
  );
}

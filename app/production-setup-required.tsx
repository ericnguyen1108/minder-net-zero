export default function ProductionSetupRequired({ missing }: { missing: string[] }) {
  return (
    <main className="production-setup" role="alert">
      <section>
        <div className="brand-mark" aria-hidden="true">m<span /></div>
        <p className="eyebrow">Secure setup required</p>
        <h1>Minder Net Zero is safely locked</h1>
        <p>
          Multi-user mode was requested, but its private account or database connection is incomplete.
          No competition data is available until an administrator completes the setup.
        </p>
        {missing.length > 0 ? (
          <div className="production-setup-list">
            <strong>Administrator action needed</strong>
            <ul>{missing.map((name) => <li key={name}>{name}</li>)}</ul>
          </div>
        ) : null}
      </section>
    </main>
  );
}

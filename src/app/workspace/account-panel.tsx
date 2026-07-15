"use client";

import { useEffect, useRef, useState } from "react";

type MaskedConnection = Readonly<{
  connectionReference: string;
  provider: string;
  environment: string;
  verification: string;
  maskedHint: string;
}>;

export function AccountPanel({
  accountReference,
  vaultDisabled,
}: Readonly<{ accountReference: string; vaultDisabled: boolean }>) {
  const [connections, setConnections] = useState<MaskedConnection[] | undefined>(undefined);
  const [status, setStatus] = useState("");
  const logoutRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/connections")
      .then((response) => (response.ok ? response.json() : { connections: [] }))
      .then((data: { connections?: MaskedConnection[] }) => {
        if (active) setConnections(data.connections ?? []);
      })
      .catch(() => {
        if (active) setConnections([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function logout(): Promise<void> {
    setStatus("로그아웃 중입니다...");
    await fetch("/api/auth/revoke", { method: "POST", headers: { "Content-Type": "application/json" } }).catch(() => undefined);
    window.location.assign("/signin");
  }

  return (
    <section data-role="account-panel" style={{ marginBottom: "16px", padding: "12px", border: "1px solid #444", borderRadius: "8px" }}>
      <p style={{ margin: "0 0 8px" }}>
        로그인 계정: <span data-role="account-reference">{accountReference}</span>
      </p>
      <button ref={logoutRef} type="button" onClick={logout} style={{ minHeight: "44px" }}>
        로그아웃
      </button>
      <p aria-live="polite" style={{ minHeight: "1.25rem" }}>
        {status}
      </p>

      <h2 style={{ fontSize: "1rem", margin: "12px 0 4px" }}>제공자 연결</h2>
      {vaultDisabled ? (
        <p data-role="connections-config">설정 필요</p>
      ) : connections === undefined ? (
        <p aria-live="polite">불러오는 중...</p>
      ) : connections.length === 0 ? (
        <p data-role="connections-empty">연결된 제공자가 없습니다.</p>
      ) : (
        <ul data-role="connections-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {connections.map((connection) => (
            <li key={connection.connectionReference} data-role="connection-item">
              {connection.provider} · {connection.environment} · {connection.verification} · ****{connection.maskedHint}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

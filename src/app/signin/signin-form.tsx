"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";

type Stage = "request" | "code";

export function SignInForm({ initialError = false, providers = [] }: Readonly<{ initialError?: boolean; providers?: readonly ("google" | "github")[] }>) {
  const [stage, setStage] = useState<Stage>("request");
  const [email, setEmail] = useState("");
  const [purpose, setPurpose] = useState<"verify_email" | "sign_in" | "recover">("verify_email");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState(initialError ? "로그인에 실패했습니다. 다시 시도해 주세요." : "");
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const purposeId = useId();
  const codeId = useId();
  const codeRef = useRef<HTMLInputElement>(null);

  // Focus management (WS-06): move focus to the code field when it mounts, deterministically.
  useEffect(() => {
    if (stage === "code") codeRef.current?.focus();
  }, [stage]);

  async function submitRequest(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus("인증 메일을 요청하는 중입니다...");
    try {
      const response = await fetch("/api/auth/email/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, email, idempotencyKey: `${email}:${purpose}:${Date.now()}` }),
      });
      if (!response.ok) throw new Error("request failed");
      setStatus("인증 코드를 보냈습니다. 메일함의 코드를 입력해 주세요.");
      setStage("code"); // the stage effect focuses the code field once it mounts
    } catch {
      setStatus("요청을 처리하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus("코드를 확인하는 중입니다...");
    try {
      const response = await fetch("/api/auth/email/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "manual_code", proof: code }),
      });
      const data = (await response.json()) as { status?: string };
      if (data.status === "issued") {
        setStatus("로그인되었습니다. 이동합니다...");
        window.location.assign("/");
        return;
      }
      setStatus("코드가 올바르지 않습니다. 다시 확인해 주세요.");
    } catch {
      setStatus("코드를 확인하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: "28rem", margin: "0 auto", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.4rem", marginBottom: "16px" }}>로그인</h1>

      {stage === "request" ? (
        <form onSubmit={submitRequest} data-role="signin-request">
          <label htmlFor={purposeId} style={{ display: "block", marginBottom: "4px" }}>
            목적
          </label>
          <select
            id={purposeId}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as typeof purpose)}
            style={{ display: "block", width: "100%", minHeight: "44px", marginBottom: "12px" }}
          >
            <option value="verify_email">이메일 인증</option>
            <option value="sign_in">로그인</option>
            <option value="recover">계정 복구</option>
          </select>

          <label htmlFor={emailId} style={{ display: "block", marginBottom: "4px" }}>
            이메일
          </label>
          <input
            id={emailId}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={{ display: "block", width: "100%", minHeight: "44px", marginBottom: "12px", boxSizing: "border-box" }}
          />

          <button type="submit" disabled={busy} style={{ minHeight: "44px", width: "100%" }}>
            인증 메일 보내기
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode} data-role="signin-code">
          <label htmlFor={codeId} style={{ display: "block", marginBottom: "4px" }}>
            인증 코드
          </label>
          <input
            id={codeId}
            ref={codeRef}
            type="text"
            required
            inputMode="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            style={{ display: "block", width: "100%", minHeight: "44px", marginBottom: "12px", boxSizing: "border-box" }}
          />
          <button type="submit" disabled={busy} style={{ minHeight: "44px", width: "100%" }}>
            코드 확인
          </button>
        </form>
      )}

      <p aria-live="polite" data-role="signin-status" style={{ minHeight: "1.5rem", marginTop: "12px" }}>
        {status}
      </p>

      {providers.length > 0 ? (
        <nav style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {providers.includes("google") ? (
            <Link href="/auth/signin/google" style={{ minHeight: "44px", display: "flex", alignItems: "center" }}>
              Google로 로그인
            </Link>
          ) : null}
          {providers.includes("github") ? (
            <Link href="/auth/signin/github" style={{ minHeight: "44px", display: "flex", alignItems: "center" }}>
              GitHub로 로그인
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}

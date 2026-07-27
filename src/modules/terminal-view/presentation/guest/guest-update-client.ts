"use client";

import { useEffect, useRef, useState } from "react";

import type {
  GuestPanelState,
  GuestPanelUpdate,
  GuestTerminalSnapshot,
  PublicPanelKey,
} from "./contracts";
import { publicPanelKeys } from "./contracts";
import { createGuestDeadlineOutcome, GUEST_DEADLINE_AFTER_MS } from "./guest-deadline";

function isPanelKey(value: unknown): value is PublicPanelKey {
  return typeof value === "string" && (publicPanelKeys as readonly string[]).includes(value);
}

function parseGuestPanelUpdate(value: unknown): GuestPanelUpdate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<GuestPanelUpdate>;
  if (!isPanelKey(candidate.panelKey) || typeof candidate.requestRevision !== "string") return undefined;
  if (typeof candidate.resumeIdentity !== "string" || candidate.resumeIdentity.length < 8) return undefined;
  if (!Number.isInteger(candidate.sequence) || (candidate.sequence ?? 0) < 1) return undefined;
  if (typeof candidate.completed !== "boolean") return undefined;
  if (!candidate.state || candidate.state.panelKey !== candidate.panelKey) return undefined;
  if (candidate.state.requestRevision !== candidate.requestRevision) return undefined;
  return candidate as GuestPanelUpdate;
}

export function useGuestPanelUpdates(
  snapshot: GuestTerminalSnapshot,
  updateUrl: string,
): readonly GuestPanelState[] {
  const [panelState, setPanelState] = useState<Readonly<{
    requestRevision: string;
    panels: readonly GuestPanelState[];
  }>>({ requestRevision: snapshot.requestRevision, panels: snapshot.panels });
  const sequenceByStreamAndPanel = useRef(new Map<string, number>());

  useEffect(() => {
    sequenceByStreamAndPanel.current.clear();
    const source = new EventSource(updateUrl);
    source.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data)) as unknown;
      } catch {
        return;
      }
      const update = parseGuestPanelUpdate(parsed);
      if (!update || update.requestRevision !== snapshot.requestRevision) return;
      const sequenceKey = `${update.resumeIdentity}:${update.panelKey}`;
      const previousSequence = sequenceByStreamAndPanel.current.get(sequenceKey) ?? 0;
      if (update.sequence <= previousSequence) return;
      sequenceByStreamAndPanel.current.set(sequenceKey, update.sequence);
      setPanelState((current) => {
        const panels = current.requestRevision === snapshot.requestRevision ? current.panels : snapshot.panels;
        return {
          requestRevision: snapshot.requestRevision,
          panels: panels.map((panel) => panel.panelKey === update.panelKey ? update.state : panel),
        };
      });
    };
    source.onerror = () => source.close();

    const safetyDelayMs = Math.min(
      GUEST_DEADLINE_AFTER_MS + 500,
      Math.max(0, snapshot.safetyDeadlineAfterMs) + 500,
    );
    const safetyDeadline = window.setTimeout(() => {
      setPanelState((current) => {
        const panels = current.requestRevision === snapshot.requestRevision ? current.panels : snapshot.panels;
        return {
          requestRevision: snapshot.requestRevision,
          panels: panels.map((panel) => panel.state === "pending" ? {
            panelKey: panel.panelKey,
            state: "ready",
            requestRevision: panel.requestRevision,
            outcome: createGuestDeadlineOutcome(panel.panelKey, new Date().toISOString()),
          } : panel),
        };
      });
      source.close();
    }, safetyDelayMs);

    source.addEventListener("complete", () => {
      window.clearTimeout(safetyDeadline);
      source.close();
    });

    return () => {
      window.clearTimeout(safetyDeadline);
      source.close();
    };
  }, [snapshot.panels, snapshot.requestRevision, snapshot.safetyDeadlineAfterMs, updateUrl]);

  return panelState.requestRevision === snapshot.requestRevision ? panelState.panels : snapshot.panels;
}

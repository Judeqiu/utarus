/**
 * Bridge HTTP request → utarus agent.
 *
 * Subscribes to the pi-agent-core event stream and pushes each event into
 * the stream-registry keyed by messageId. The actual SSE wire write happens
 * in the router (driven by the registry's subscriber callback).
 *
 * Mirrors interfaces/slack/app.ts getAgentResponse, with two changes:
 *   1. Events go to the registry instead of Slack-specific callbacks.
 *   2. Heartbeat ticks every 3s so the client can render an elapsed timer.
 *
 * Spec: docs/webui-chat-design.md §6, §9.
 */

import { emit, markEnded } from './stream-registry.js';
import { extractAssets } from './extract-assets.js';
import {
  ensureCardFencesInText,
  fenceBodyFromCardToolResult,
} from './card-fences.js';
import {
  ensureWidgetFencesInText,
  fenceBodyFromWidgetToolResult,
} from './widget-fences.js';
import type { WebAgent, WebImageContent } from './types.js';

const WIDGET_TOOLS = new Set(['show_widget', 'update_widget']);
const CARD_TOOLS = new Set(['show_card']);

/** Default WebUI / Slack agent run watchdog (10 minutes). */
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

const HEARTBEAT_INTERVAL_MS = 3000;

/**
 * Effective agent run timeout in ms. `0` means no watchdog.
 *
 * Env `UTARUS_AGENT_RUN_TIMEOUT_MS`:
 * - unset → default 10 minutes
 * - `0` → **disabled** (no watchdog abort)
 * - positive integer → timeout in milliseconds
 */
export function getAgentRunTimeoutMs(): number {
  const raw = process.env.UTARUS_AGENT_RUN_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(
      `UTARUS_AGENT_RUN_TIMEOUT_MS must be a non-negative integer (ms); 0 disables the watchdog. Got "${raw}"`,
    );
  }
  return n;
}

/**
 * Load-time snapshot of {@link getAgentRunTimeoutMs} for importers that need a
 * constant (e.g. task lease math). Prefer the getter at runtime.
 */
export const AGENT_RUN_TIMEOUT_MS = getAgentRunTimeoutMs();

interface RunAgentParams {
  messageId: string;
  userSlug: string;
  agent: WebAgent;
  message: string;
  /** Photos attached to this turn — forwarded to the agent as image parts. */
  images?: WebImageContent[];
  /**
   * Called after the agent finishes and before the terminal SSE `end` event.
   * May be async (e.g. AI title generation) — awaited so late events still ship.
   */
  onComplete?: (result: {
    text: string;
    stopReason: string;
    error?: string;
  }) => void | Promise<void>;
}

interface ActiveTool {
  name: string;
  startedAt: number;
}

/**
 * Run the agent to completion. Resolves when the agent goes idle (terminal
 * event has been pushed to the registry). Never throws — errors become the
 * terminal `error` event.
 */
export async function runAgent(params: RunAgentParams): Promise<void> {
  const { messageId, userSlug, agent, message, images, onComplete } = params;
  const startedAt = Date.now();

  let cumulative = '';
  let aborted = false;
  let lastStopReason: string | undefined;
  const activeTools = new Map<string, ActiveTool>();
  /** Fence bodies from successful show_widget / update_widget (order preserved). */
  const widgetFenceBodies: string[] = [];
  /** Fence bodies from successful show_card (order preserved). */
  const cardFenceBodies: string[] = [];

  async function finish(result: {
    text: string;
    stopReason: string;
    error?: string;
  }): Promise<void> {
    try {
      await onComplete?.(result);
    } catch (e) {
      console.error(
        `[Agent/web] onComplete failed user=${userSlug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      cumulative += event.assistantMessageEvent.delta;
      emit(messageId, {
        type: 'delta',
        text: event.assistantMessageEvent.delta,
        cumulative,
      });
      return;
    }
    if (event.type === 'message_end' && event.message?.stopReason) {
      lastStopReason = event.message.stopReason;
      if (event.message.stopReason === 'aborted') {
        aborted = true;
      } else if (event.message.stopReason === 'length') {
        console.warn(
          `[Agent/web] user=${userSlug} hit max_tokens. Truncated at ${cumulative.length} chars.`,
        );
      } else if (
        event.message.stopReason !== 'stop' &&
        event.message.stopReason !== 'toolUse'
      ) {
        console.warn(
          `[Agent/web] user=${userSlug} unexpected stopReason: ${event.message.stopReason}`,
        );
      }
      return;
    }
    if (
      event.type === 'tool_execution_start' &&
      typeof event.toolCallId === 'string' &&
      typeof event.toolName === 'string'
    ) {
      activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
      emit(messageId, {
        type: 'tool_start',
        toolCallId: event.toolCallId,
        name: event.toolName,
        startedAt: Date.now(),
      });
      return;
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      const entry = activeTools.get(event.toolCallId);
      const durMs = entry ? Date.now() - entry.startedAt : 0;
      const ok = !event.isError;
      const toolName =
        typeof event.toolName === 'string'
          ? event.toolName
          : entry?.name ?? 'unknown';
      activeTools.delete(event.toolCallId);
      emit(messageId, {
        type: 'tool_end',
        toolCallId: event.toolCallId,
        ok,
        durationMs: durMs,
      });
      // Live panel open + fence collection (independent of model paste).
      if (ok && WIDGET_TOOLS.has(toolName)) {
        try {
          const fence = fenceBodyFromWidgetToolResult(toolName, event.result);
          widgetFenceBodies.push(fence);
          emit(messageId, { type: 'widget', fence });
        } catch (e) {
          console.error(
            `[Agent/web] user=${userSlug} ${toolName} fence extract failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      // Info-card fence collection (injected into final text if model omits/mangles).
      if (ok && CARD_TOOLS.has(toolName)) {
        try {
          const fence = fenceBodyFromCardToolResult(toolName, event.result);
          cardFenceBodies.push(fence);
        } catch (e) {
          console.error(
            `[Agent/web] user=${userSlug} ${toolName} fence extract failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      return;
    }
  });

  const timeoutMs = getAgentRunTimeoutMs();
  const watchdog =
    timeoutMs > 0
      ? setTimeout(() => {
          const hung = Array.from(activeTools.values()).map(
            (t) => `${t.name}(${Math.round((Date.now() - t.startedAt) / 1000)}s)`,
          );
          console.error(
            `[Agent/web] user=${userSlug} watchdog: aborting after ${timeoutMs}ms. ` +
              `textLen=${cumulative.length} activeTools=[${hung.join(', ')}]`,
          );
          agent.abort();
        }, timeoutMs)
      : null;

  const heartbeat = setInterval(() => {
    emit(messageId, {
      type: 'heartbeat',
      elapsedMs: Date.now() - startedAt,
      activeTools: Array.from(activeTools.values()).map((t) => t.name),
    });
  }, HEARTBEAT_INTERVAL_MS);

  console.log(
    `[Agent/web] user=${userSlug} start messageId=${messageId} msgLen=${message.length}` +
      (timeoutMs > 0 ? ` timeoutMs=${timeoutMs}` : ' timeout=disabled'),
  );

  try {
    agent.prompt(message, images && images.length > 0 ? images : undefined);
    await agent.waitForIdle();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Agent/web] user=${userSlug} threw: ${msg}`);
    await finish({ text: cumulative, stopReason: 'error', error: msg });
    emit(messageId, {
      type: 'error',
      message: `Agent error: ${msg}`,
      phase: 'during_run',
    });
    emit(messageId, { type: 'end' });
    markEnded(messageId);
    return;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearInterval(heartbeat);
    unsubscribe();
  }

  if (aborted) {
    // Only the watchdog sets aborted via agent.abort() for idle waits; still
    // surface a clear timeout message when a timeout was configured.
    const msg =
      timeoutMs > 0
        ? `Agent run timed out after ${Math.round(timeoutMs / 1000)}s`
        : 'Agent run was aborted';
    await finish({ text: cumulative, stopReason: 'aborted', error: msg });
    emit(messageId, {
      type: 'error',
      message: msg,
      phase: 'watchdog',
    });
    emit(messageId, { type: 'end' });
    markEnded(messageId);
    return;
  }

  if (agent.state.errorMessage) {
    console.error(
      `[Agent/web] user=${userSlug} errorMessage="${agent.state.errorMessage}" textLen=${cumulative.length}`,
    );
    await finish({
      text: cumulative,
      stopReason: 'error',
      error: agent.state.errorMessage,
    });
    emit(messageId, {
      type: 'error',
      message: `Agent error: ${agent.state.errorMessage}`,
      phase: 'during_run',
    });
    emit(messageId, { type: 'end' });
    markEnded(messageId);
    return;
  }

  const stopReason = lastStopReason ?? 'stop';
  // If the model forgot to paste ```widget / ```card fences (or mangled them),
  // inject tool-returned ones so history + WebUI cards stay consistent.
  let finalText = cumulative;
  if (widgetFenceBodies.length > 0) {
    try {
      const next = ensureWidgetFencesInText(finalText, widgetFenceBodies);
      if (next !== finalText) {
        console.log(
          `[Agent/web] user=${userSlug} injected missing widget fence(s) into final text ` +
            `(tools=${widgetFenceBodies.length})`,
        );
      }
      finalText = next;
    } catch (e) {
      console.error(
        `[Agent/web] user=${userSlug} ensureWidgetFencesInText failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  if (cardFenceBodies.length > 0) {
    try {
      const next = ensureCardFencesInText(finalText, cardFenceBodies);
      if (next !== finalText) {
        console.log(
          `[Agent/web] user=${userSlug} injected/repaired card fence(s) into final text ` +
            `(tools=${cardFenceBodies.length})`,
        );
      }
      finalText = next;
    } catch (e) {
      console.error(
        `[Agent/web] user=${userSlug} ensureCardFencesInText failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  // Emit done first so the client renders the reply; then persist + AI title
  // (title event) before end so the SSE stream still carries the new title.
  const assets = extractAssets(finalText || '', userSlug);
  emit(messageId, {
    type: 'done',
    text: finalText,
    stopReason,
    assets,
  });
  await finish({ text: finalText, stopReason });
  emit(messageId, { type: 'end' });
  markEnded(messageId);
}

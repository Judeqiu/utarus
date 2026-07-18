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
import type { WebAgent, WebImageContent } from './types.js';

export const AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 3000;

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
      activeTools.delete(event.toolCallId);
      emit(messageId, {
        type: 'tool_end',
        toolCallId: event.toolCallId,
        ok,
        durationMs: durMs,
      });
      return;
    }
  });

  const watchdog = setTimeout(() => {
    const hung = Array.from(activeTools.values()).map(
      (t) => `${t.name}(${Math.round((Date.now() - t.startedAt) / 1000)}s)`,
    );
    console.error(
      `[Agent/web] user=${userSlug} watchdog: aborting after ${AGENT_RUN_TIMEOUT_MS}ms. ` +
        `textLen=${cumulative.length} activeTools=[${hung.join(', ')}]`,
    );
    agent.abort();
  }, AGENT_RUN_TIMEOUT_MS);

  const heartbeat = setInterval(() => {
    emit(messageId, {
      type: 'heartbeat',
      elapsedMs: Date.now() - startedAt,
      activeTools: Array.from(activeTools.values()).map((t) => t.name),
    });
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[Agent/web] user=${userSlug} start messageId=${messageId} msgLen=${message.length}`);

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
    clearTimeout(watchdog);
    clearInterval(heartbeat);
    unsubscribe();
  }

  if (aborted) {
    const msg = `Agent run timed out after ${Math.round(AGENT_RUN_TIMEOUT_MS / 1000)}s`;
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
  // Emit done first so the client renders the reply; then persist + AI title
  // (title event) before end so the SSE stream still carries the new title.
  const assets = extractAssets(cumulative || '', userSlug);
  emit(messageId, {
    type: 'done',
    text: cumulative,
    stopReason,
    assets,
  });
  await finish({ text: cumulative, stopReason });
  emit(messageId, { type: 'end' });
  markEnded(messageId);
}

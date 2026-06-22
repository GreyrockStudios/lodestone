/**
 * Copyright (c) 2026 Greyrock Studios. MIT License.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TUI code uses dynamic types throughout */
/**
 * Lodestone — TUI Chat Index
 *
 * Main orchestrator for the TUI chat interface.
 * Wires up TUI layout, event handlers, streaming, slash commands,
 * onboarding, and boot sequence.
 */

import { TUI, ProcessTerminal, Text, Box, Markdown, Editor, Spacer } from "@earendil-works/pi-tui";
import { LodestoneEngine } from "../engine.js";
import { AgentLoop } from "../agent-loop.js";
import { StreamHandler } from "../streaming/handler.js";
import { ChatRenderer, StatusState } from "./streaming.js";
import { ChatMessage } from "./messages.js";
import { getTheme, DEFAULT_THEME, THEMES, THEME_NAMES, fg } from "./theme.js";
import { ScrollViewport } from "./scroll-viewport.js";
import { handleCommand, CommandContext } from "./commands.js";
import { boot, generateSurpriseName, applyAgentName } from "./boot.js";
import { runOnboarding } from "../tui-onboarding/conversational.js";
import { resolve } from "path";
import { existsSync } from "fs";

const R = "\x1B[0m";
const B = "\x1B[1m";

/**
 * Main entry point for the TUI chat.
 */
export async function startTUI(workspace?: string, model?: string): Promise<void> {
  let WORKSPACE = workspace || process.env.LODESTONE_WORKSPACE || "/tmp/lodestone-test/workspace";
  const effectiveModel = model || process.env.LODESTONE_MODEL || "glm-5.2:cloud";

  // ─── TUI Setup ────────────────────────────────────────────────────────

  const term = new ProcessTerminal();
  const tui = new TUI(term);
  let theme = getTheme(DEFAULT_THEME);

  const chatLog = new ScrollViewport();

  const bootMsg = new Markdown("", 1, 1, theme.markdown as any);
  bootMsg.setText(
    `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} Lodestone${R}  Booting...`
  );
  chatLog.addChild(bootMsg);
  chatLog.addChild(new Spacer(1));

  const statusText = new Text(
    ` ${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon}${R} Booting... `,
    0,
    0
  );
  const statusBar = new Box(0, 0, (line: string) => `${"\x1B[48;2;30;35;42m"}${line}${R}`);
  statusBar.addChild(statusText);

  const selectListTheme = {
    selectedBg: (s: string) => `${"\x1B[48;2;60;65;75m"}${s}${R}`,
    selectedFg: (s: string) => `${"\x1B[38;2;246;196;83m"}${s}${R}`,
    itemBg: (s: string) => s,
    itemFg: (s: string) => `${"\x1B[2m"}${s}${R}`,
    descriptionBg: (s: string) => s,
    descriptionFg: (s: string) => `${"\x1B[2m"}${s}${R}`,
    borderChar: "─",
    borderFg: (s: string) => `${"\x1B[38;2;60;65;75m"}${s}${R}`,
    scrollIndicator: "▼",
    scrollFg: "\x1B[2m",
    maxVisible: 5,
  };

  const editor = new Editor(tui, {
    borderColor: (s: string) => `${"\x1B[38;2;60;65;75m"}${s}${R}`,
    selectList: selectListTheme as any,
  });

  // Layout: chatLog (flex) → status bar → editor (bottom)
  (tui as unknown as { addChild: (child: unknown, weight: number) => void }).addChild(chatLog, 1);
  tui.addChild(statusBar);
  tui.addChild(editor);
  tui.setFocus(editor);

  // Start TUI immediately
  tui.start();

  // ─── Create renderer ─────────────────────────────────────────────────

  const renderer = new ChatRenderer(chatLog, statusText, tui, DEFAULT_THEME);
  renderer.setChannelInfoProvider(getChannelInfo);
  let isProcessing = false;
  let engine: LodestoneEngine;
  let loop: AgentLoop;
  let identity: any;
  let sessionId: string;
  let displayName = "Lodestone";
  let bootResult: any;

  // ─── Onboarding check ────────────────────────────────────────────────

  const workspaceExists = existsSync(resolve(WORKSPACE, "IDENTITY.md"));

  if (!workspaceExists) {
    bootMsg.setText(
      `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} ${displayName}${R}\n\nNo workspace found. Let's set one up!`
    );
    tui.requestRender();

    const onboardingResult = await runOnboarding(
      renderer.Messages,
      (msg: ChatMessage) => renderer.addMessage(msg),
      editor,
      () => renderer.refreshAll(),
      (state: StatusState, detail?: string) => renderer.updateStatus(state, detail),
      WORKSPACE
    );

    if (!onboardingResult) {
      tui.stop();
      process.stdout.write(`\n${"\x1B[2m"}Setup cancelled.${R}\n\n`);
      process.exit(0);
    }

    // Update workspace and model from onboarding
    process.env.LODESTONE_WORKSPACE = onboardingResult.workspace;
    process.env.LODESTONE_MODEL = onboardingResult.model;
    WORKSPACE = onboardingResult.workspace;

    bootMsg.setText(
      `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} ${displayName}${R}\n\nWorkspace created! Booting...`
    );
    tui.requestRender();
  }

  // ─── Boot Engine ─────────────────────────────────────────────────────

  try {
    bootResult = await boot(WORKSPACE, effectiveModel, (msg: string) => {
      bootMsg.setText(
        `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} ${displayName}${R}\n${msg}`
      );
      tui.requestRender();
    });

    engine = bootResult.engine;
    loop = bootResult.loop;
    sessionId = bootResult.sessionId;
    identity = bootResult.identity;
    displayName = bootResult.displayName;
    WORKSPACE = bootResult.workspace;

    renderer.setDisplayName(displayName);
    renderer.setModelName(bootResult.model);

    // Handle "surprise me" name
    if (
      (
        bootResult as unknown as {
          onboardingResult?: { agentName?: string; userName?: string; templates?: string[] };
        }
      ).onboardingResult?.agentName === "__surprise__"
    ) {
      const chosenName = await generateSurpriseName(
        engine,
        (
          bootResult as unknown as {
            onboardingResult?: { agentName?: string; userName?: string; templates?: string[] };
          }
        ).onboardingResult?.userName || "User",
        (
          bootResult as unknown as {
            onboardingResult?: { agentName?: string; userName?: string; templates?: string[] };
          }
        ).onboardingResult?.templates || [],
        (msg: string) => {
          bootMsg.setText(
            `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} ${displayName}${R}\n${msg}`
          );
          tui.requestRender();
        }
      );
      if (chosenName) {
        applyAgentName(WORKSPACE, chosenName);
        identity = await engine.identity.load();
        displayName = identity?.identity?.name || chosenName;
        renderer.setDisplayName(displayName);
        renderer.pushMessage({
          role: "system",
          text: `${"\x1B[38;2;125;211;165m"}I'm ${B}${chosenName}${R}. Nice to meet you.`,
          ts: Date.now(),
        });
        renderer.addMessage(renderer.Messages[renderer.Messages.length - 1]);
        tui.requestRender();
      }
    }

    // Boot complete
    const toolCount = engine.tools.listDefinitions().length;
    const welcomeText = [
      `${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} ${displayName} ready.${R}`,
      `**Identity:** ${identity.identity.name}  ·  **Model:** ${bootResult.model}  ·  **Tools:** ${toolCount}`,
      `Self-improvement: ${"\x1B[38;2;125;211;165m"}✓${R}  ·  Predictions  ·  RBT  ·  Drift  ·  Skills  ·  Sleep`,
      "",
      "Type a message to chat, or /help for commands.",
      `${"\x1B[2m"}Tip: Alt+Enter for multi-line input. PgUp/PgDn to scroll.${R}`,
    ].join("\n");
    bootMsg.setText(welcomeText);
    renderer.updateStatus("ready");
    tui.requestRender();
  } catch (err) {
    bootMsg.setText(
      `${"\x1B[38;2;220;38;38m"}**Boot failed:** ${err instanceof Error ? err.message : String(err)}`
    );
    renderer.updateStatus("error");
    tui.requestRender();
    console.error("Boot error:", err);
    return;
  }

  // ─── Submit Handler ──────────────────────────────────────────────────

  editor.onSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    editor.setText("");

    // Check slash commands
    if (trimmed.startsWith("/")) {
      const ctx: CommandContext = {
        engine,
        messages: renderer.Messages,
        identity,
        displayName,
        model: bootResult.model,
        scrollOffset: renderer.ScrollOffset,
        theme,
        refreshAll: () => renderer.refreshAll(),
        updateStatus: (state, detail) => renderer.updateStatus(state as StatusState, detail),
        runOnboarding: async () => {
          return runOnboarding(
            renderer.Messages,
            (msg: ChatMessage) => renderer.addMessage(msg),
            editor,
            () => renderer.refreshAll(),
            (state: StatusState, detail?: string) => renderer.updateStatus(state, detail),
            WORKSPACE
          );
        },
        createSession: () => {
          const newId = engine.createSession();
          sessionId = newId;
          loop = new AgentLoop(engine, {
            maxToolRounds: 10,
            maxTokens: 4096,
            temperature: 0.7,
            stream: true,
            autoCapture: true,
            autoRecall: true,
          });
          return newId;
        },
        setTheme: (name: string) => {
          theme = getTheme(name);
          renderer.setTheme(theme);
          bootMsg.setText(
            `${B}${fg(theme.colors.accent)}${theme.statusBar.icon} ${displayName}${R}  Theme changed to ${B}${theme.name}${R}`
          );
          tui.requestRender();
        },
        cleanup,
      };

      const result = await handleCommand(trimmed, ctx);
      if (result.handled) {
        if (result.themeChanged) {
          ctx.setTheme(result.themeChanged);
          renderer.addMessage({
            role: "system",
            text: `Theme changed to ${B}${result.themeChanged}${R}`,
            ts: Date.now(),
          });
          renderer.refreshAll();
        }
        return;
      }
    }

    // ─── LLM with streaming ─────────────────────────────────────────

    isProcessing = true;
    renderer.pushMessage({ role: "user", text: trimmed, ts: Date.now() });
    renderer.addMessage(renderer.Messages[renderer.Messages.length - 1]);
    renderer.incrementMsgCount();
    tui.requestRender();
    renderer.updateStatus("thinking", "waiting for LLM");

    const streamHandler = new StreamHandler();

    streamHandler.on("text_delta", (event: any) => {
      const delta = (event.data as { text: string }).text;
      if (!renderer.IsStreaming) {
        renderer.startStreamingMessage();
        renderer.updateStatus("streaming");
      }
      renderer.appendStreamingText(delta);
    });

    streamHandler.on("tool_call_start", (event: any) => {
      const data = event.data as { toolCallId: string; toolName: string };
      renderer.updateStatus("tool", data.toolName);
      renderer.pushMessage({
        role: "tool",
        text: "",
        ts: Date.now(),
        toolName: data.toolName,
        toolSuccess: true,
        toolDuration: 0,
        toolSummary: "running...",
      });
    });

    streamHandler.on("tool_result", (event: any) => {
      const data = event.data as {
        toolName: string;
        success: boolean;
        result: string;
        durationMs: number;
      };
      renderer.updateToolResult(
        data.toolName,
        data.success,
        data.durationMs,
        data.result?.slice(0, 120) || ""
      );
      renderer.updateStatus("streaming", `tool: ${data.toolName}`);
      renderer.refreshAll();
    });

    try {
      const result = await loop.run(sessionId, trimmed, streamHandler);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        text: result.response || renderer.StreamingBuffer || "(no response)",
        ts: Date.now(),
        tokens: result.totalTokens,
        ms: result.durationMs,
        tools: result.toolCalls.map((tc) => tc.toolName),
      };

      if (renderer.IsStreaming) {
        renderer.finishStreamingMessage(assistantMsg);
      } else {
        renderer.addMessage(assistantMsg);
      }

      // Update tool messages with final durations
      for (const tc of result.toolCalls) {
        renderer.updateToolResult(
          tc.toolName,
          tc.success,
          tc.durationMs,
          tc.summary?.slice(0, 120) || ""
        );
      }

      isProcessing = false;
      renderer.incrementMsgCount();
      renderer.updateStatus("ready", `${renderer.MsgCount} msgs`);
      renderer.refreshAll();
    } catch (err) {
      const errMsg: ChatMessage = {
        role: "system",
        text: `${"\x1B[38;2;220;38;38m"}**Error:** ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now(),
      };

      if (renderer.IsStreaming) {
        renderer.finishStreamingMessage(errMsg);
      } else {
        renderer.addMessage(errMsg);
      }

      isProcessing = false;
      renderer.updateStatus("error");
      renderer.refreshAll();
    }
  };

  // ─── Channel info helper ─────────────────────────────────────────────

  function getChannelInfo(): string | undefined {
    if (engine?.channelManager?.isRunning()) {
      const channels = engine.channelManager.listChannels();
      if (channels.length > 0) {
        return channels.map((c) => `${fg(theme.colors.success)}${c.name}✓${R}`).join(" ");
      }
    }
    return undefined;
  }

  // ─── Keyboard Handler (Scroll) ──────────────────────────────────────────

  tui.addInputListener((data: string) => {
    if (data === "\x1b[5~" || data === "\x1b[5;~") {
      renderer.scrollUp(10);
      renderer.updateStatus("ready");
      return { consume: true };
    }
    if (data === "\x1b[6~" || data === "\x1b[6;~") {
      renderer.scrollDown(10);
      renderer.updateStatus("ready");
      return { consume: true };
    }
    if (data === "\x1b[H" || data === "\x1b[1~") {
      renderer.scrollToTop();
      renderer.updateStatus("ready");
      return { consume: true };
    }
    if (data === "\x1b[F" || data === "\x1b[4~") {
      renderer.scrollToBottom();
      renderer.updateStatus("ready");
      return { consume: true };
    }
    return undefined;
  });

  // ─── Cleanup ────────────────────────────────────────────────────────

  (editor as unknown as { onEscape: () => void }).onEscape = () => {
    cleanup();
  };
  process.on("SIGINT", () => {
    cleanup();
  });
  process.on("SIGTERM", () => {
    cleanup();
  });

  function cleanup() {
    tui.stop();
    process.stdout.write(
      `\n${B}${"\x1B[38;2;246;196;83m"}${theme.statusBar.icon} Lodestone${R} session ended.\n\n`
    );
    process.exit(0);
  }
}

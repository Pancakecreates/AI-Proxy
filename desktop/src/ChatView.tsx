import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  ArrowUp,
  Square,
  Trash2,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  SlidersHorizontal,
} from "lucide-react";
import type { BackendModelEntry, ChatMessageRecord, ChatSummary, ThoughtLevel } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";
import { Button, Textarea } from "./components/ui";
import { formatDuration, formatTokens } from "./format";

import { useI18n } from "./i18n";
interface ChatViewProps {
  models: BackendModelEntry[];
  defaultModel: string;
  showThinking: boolean;
  preselectedModelId?: string | null;
}

export const ChatView: React.FC<ChatViewProps> = ({
  models,
  defaultModel,
  showThinking,
  preselectedModelId,
}) => {
  const { t, lang } = useI18n();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState(preselectedModelId || defaultModel);
  const [effort, setEffort] = useState("high");
  const [protocol, setProtocol] = useState("anthropic");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamThinking, setStreamThinking] = useState("");
  const [streamText, setStreamText] = useState("");
  const [openThinkIds, setOpenThinkIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadChats = async () => {
    const list = await invoke<ChatSummary[]>("list_chats");
    setChats(list);
    if (!activeChatId && list.length > 0 && list[0]) {
      setActiveChatId(list[0].id);
    }
  };

  useEffect(() => {
    loadChats().catch(() => {});
  }, []);

  useEffect(() => {
    if (preselectedModelId) {
      setModelId(preselectedModelId);
    }
  }, [preselectedModelId]);

  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const chat = chats.find((c) => c.id === activeChatId);
    if (chat) {
      setModelId(chat.modelId || defaultModel);
      setEffort(chat.effort || "high");
      setProtocol(chat.protocol || "anthropic");
      setSystemPrompt(chat.systemPrompt || "");
    }
    invoke<ChatMessageRecord[]>("get_chat_messages", { chatId: activeChatId })
      .then(setMessages)
      .catch(() => {});
  }, [activeChatId]);

  useEffect(() => {
    const unlisten = listen<{ chatId: string; kind: string; chunk?: string }>("chat-stream", (ev) => {
      if (ev.payload.chatId !== activeChatId) return;
      if (ev.payload.kind === "thinking" && ev.payload.chunk) {
        setStreamThinking((prev) => prev + ev.payload.chunk);
      } else if (ev.payload.kind === "text" && ev.payload.chunk) {
        setStreamText((prev) => prev + ev.payload.chunk);
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [activeChatId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamText, streamThinking]);

  const handleNewChat = async () => {
    const picked = modelId || models[0]?.qualifiedId || defaultModel;
    const created = await invoke<ChatSummary>("create_chat", {
      title: `${t("Тест")} · ${new Date().toLocaleTimeString(lang === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" })}`,
      modelId: picked,
      protocol,
      effort,
      systemPrompt,
    });
    setChats((prev) => [created, ...prev]);
    setActiveChatId(created.id);
    setMessages([]);
    setError(null);
  };

  const handleDeleteChat = async (id: string) => {
    await invoke("delete_chat", { chatId: id });
    const next = chats.filter((c) => c.id !== id);
    setChats(next);
    if (activeChatId === id) {
      setActiveChatId(next[0]?.id ?? null);
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setError(null);

    let targetChatId = activeChatId;
    if (!targetChatId) {
      const picked = modelId || models[0]?.qualifiedId || defaultModel;
      const created = await invoke<ChatSummary>("create_chat", {
        title: trimmed.slice(0, 40),
        modelId: picked,
        protocol,
        effort,
        systemPrompt,
      });
      setChats((prev) => [created, ...prev]);
      targetChatId = created.id;
      setActiveChatId(created.id);
    } else {
      await invoke("update_chat_meta", {
        chatId: targetChatId,
        modelId,
        protocol,
        effort,
        systemPrompt,
      }).catch(() => {});
    }

    const tempUser: ChatMessageRecord = {
      id: `tmp-${Date.now()}`,
      chatId: targetChatId,
      role: "user",
      content: trimmed,
      thinking: "",
      modelId,
      effort,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      costUsd: 0,
      usageSource: "none",
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempUser]);
    setInput("");
    setStreamThinking("");
    setStreamText("");
    setSending(true);

    try {
      const reply = await invoke<ChatMessageRecord>("send_chat_message", {
        chatId: targetChatId,
        content: trimmed,
        modelId,
        effort,
        protocol,
        systemPrompt,
      });
      setMessages((prev) => [...prev.filter((m) => m.id !== tempUser.id), tempUser, reply]);
      loadChats().catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      setStreamThinking("");
      setStreamText("");
    }
  };

  const handleStop = () => {
    if (activeChatId) {
      invoke("stop_chat_generation", { chatId: activeChatId }).catch(() => {});
    }
  };

  const selectedModelMeta = models.find(
    (m) => m.qualifiedId === modelId || m.gatewayId === modelId || m.nativeId === modelId,
  );

  const THOUGHT_ORDER: ThoughtLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const supportedEfforts = selectedModelMeta?.supportedEfforts ?? [];
  const effortLevels = (supportedEfforts.length > 0
    ? THOUGHT_ORDER.filter((lvl) => supportedEfforts.includes(lvl))
    : THOUGHT_ORDER) as ThoughtLevel[];
  const effortLabel = (lvl: ThoughtLevel): string =>
    ({
      none: t("Выкл"),
      minimal: t("Минимальное"),
      low: t("Низкое"),
      medium: t("Среднее"),
      high: t("Высокое"),
      xhigh: t("Очень высокое"),
      max: t("Максимум"),
    })[lvl] ?? lvl;

  useEffect(() => {
    if (supportedEfforts.length > 0 && !supportedEfforts.includes(effort as ThoughtLevel)) {
      setEffort(supportedEfforts[supportedEfforts.length - 1] ?? effort);
    }
  }, [selectedModelMeta?.qualifiedId]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-[var(--sidebar-bg)]">
        <div className="flex h-11 items-center justify-between border-b px-2.5">
          <span className="text-[11px] font-medium text-[var(--fg-subtle)]">{t("Чаты")}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewChat}
            title={t("Новый чат")}
            aria-label={t("Новый чат")}
            className="size-6.5"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="flex-1 space-y-px overflow-y-auto p-1.5">
          {chats.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-[var(--fg-subtle)]">
              {t("Нет сохранённых чатов. Напишите сообщение или нажмите «+».")}
            </div>
          ) : (
            chats.map((c) => {
              const active = c.id === activeChatId;
              return (
                <div
                  key={c.id}
                  onClick={() => setActiveChatId(c.id)}
                  className={`group flex cursor-pointer items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 transition-colors ${
                    active
                      ? "bg-[var(--nav-active)] text-[var(--fg)]"
                      : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <MessageSquare
                      className={`size-3.5 shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--fg-subtle)]"}`}
                      strokeWidth={1.8}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-[12px]">{c.title}</div>
                      <div className="truncate text-[11px] tabular-nums text-[var(--fg-subtle)]">
                        {t("{count} сообщ.", { count: c.messageCount })}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteChat(c.id);
                    }}
                    aria-label={t("Удалить чат")}
                    className="p-0.5 text-[var(--fg-subtle)] opacity-0 transition-opacity hover:text-[var(--danger)] group-hover:opacity-100"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        <div className="flex h-11 flex-wrap items-center gap-1.5 border-b px-3">
          <BrandIcon brand={selectedModelMeta?.brand ?? "devin"} size={16} />
          <Select
            value={modelId}
            onChange={setModelId}
            searchable
            searchPlaceholder={t("Поиск модели…")}
            ariaLabel={t("Модель")}
            placeholder={t("Выберите модель…")}
            className="min-w-0 flex-1"
            options={
              models.length === 0
                ? [{ value: modelId, label: modelId }]
                : models.map((m) => ({
                    value: m.qualifiedId,
                    label: m.displayName,
                    hint: m.description,
                  }))
            }
          />

          <Select
            value={effort}
            onChange={setEffort}
            ariaLabel={t("Усилие")}
            className="w-40"
            options={effortLevels.map((lvl) => ({ value: lvl, label: effortLabel(lvl) }))}
          />

          <Select
            value={protocol}
            onChange={setProtocol}
            ariaLabel={t("Протокол")}
            className="w-28"
            options={[
              { value: "anthropic", label: "Anthropic" },
              { value: "openai", label: "OpenAI" },
            ]}
          />

          <Button
            variant={showSystem ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setShowSystem((v) => !v)}
            title={t("Системный промпт")}
            aria-label={t("Системный промпт")}
            className="size-7"
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
        </div>

        {showSystem && (
          <div className="border-b bg-[var(--bg-subtle)] px-3 py-2">
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t("Системные инструкции для этого тестового чата…")}
              rows={2}
              className="bg-[var(--bg-elevated)] text-[12px]"
            />
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-5 px-6 py-5">
            {messages.length === 0 && !sending && (
              <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
                <BrandIcon brand={selectedModelMeta?.brand ?? "claude"} size={28} />
                <div className="text-[13px] font-medium text-[var(--fg)]">{t("Песочница моделей")}</div>
                <p className="max-w-xs text-[12px] leading-relaxed text-[var(--fg-muted)] text-pretty">
                  {t("Сообщения сохраняются в локальную SQLite, ответы измеряются по токенам, времени ответа и стоимости.")}
                </p>
              </div>
            )}

            {messages.map((m) => {
              const isUser = m.role === "user";
              const thinkOpen = openThinkIds[m.id] ?? showThinking;
              if (isUser) {
                return (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[8px] bg-[var(--bg-subtle)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--fg)]">
                      {m.content}
                    </div>
                  </div>
                );
              }
              return (
                <div key={m.id} className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
                    <BrandIcon brand={selectedModelMeta?.brand ?? "claude"} size={12} />
                    <span className="truncate">{m.modelId}</span>
                  </div>
                  {m.thinking && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setOpenThinkIds((p) => ({ ...p, [m.id]: !thinkOpen }))}
                        className="inline-flex items-center gap-1 text-[11px] text-[var(--fg-subtle)] transition-colors hover:text-[var(--fg-muted)]"
                      >
                        {thinkOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        <span>{t("Ход мыслей")}</span>
                      </button>
                      {thinkOpen && (
                        <pre className="mt-1 whitespace-pre-wrap rounded-[6px] bg-[var(--bg-subtle)] p-3 text-[11px] leading-relaxed text-[var(--fg-muted)]">
                          {m.thinking}
                        </pre>
                      )}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fg)] text-pretty">
                    {m.content}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-[var(--fg-subtle)]">
                    <span>{formatTokens(m.inputTokens)} {t("вх.")}</span>
                    <span>{formatTokens(m.outputTokens)} {t("исх.")}</span>
                    <span>{m.usageSource === "measured" ? t("точно") : t("оценка")}</span>
                    <span>{formatDuration(m.latencyMs)}</span>
                    {m.costUsd > 0 && <span>${m.costUsd.toFixed(4)}</span>}
                  </div>
                </div>
              );
            })}

            {sending && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-subtle)]">
                  <BrandIcon brand={selectedModelMeta?.brand ?? "claude"} size={12} />
                  <span className="truncate">{modelId}</span>
                </div>
                {streamThinking && showThinking && (
                  <pre className="whitespace-pre-wrap rounded-[6px] bg-[var(--bg-subtle)] p-3 text-[11px] leading-relaxed text-[var(--fg-muted)]">
                    {streamThinking}
                  </pre>
                )}
                <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--fg)]">
                  {streamText || <span className="text-[var(--fg-subtle)]">{t("Ожидание ответа модели…")}</span>}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-[6px] border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-[var(--danger)]">
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="border-t px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-[8px] border bg-[var(--bg-elevated)] shadow-[var(--shadow-raised)] transition-colors focus-within:border-[var(--border-strong)]">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={t("Напишите запрос…")}
                rows={2}
                className="resize-none rounded-[8px] border-transparent bg-transparent px-3 py-2.5 text-[13px] hover:bg-transparent focus:border-transparent focus:bg-transparent"
              />
              <div className="flex items-center justify-between gap-2 px-2 pb-2 pl-3">
                <span className="text-[11px] text-[var(--fg-subtle)]">
                  {t("Enter отправит, Shift+Enter перенесёт строку")}
                </span>
                {sending ? (
                  <Button variant="secondary" size="sm" onClick={handleStop}>
                    <Square className="size-2.5 fill-current" />
                    <span>{t("Остановить")}</span>
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="icon"
                    onClick={handleSend}
                    disabled={!input.trim()}
                    title={t("Отправить")}
                    aria-label={t("Отправить")}
                    className="size-7 rounded-[6px]"
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

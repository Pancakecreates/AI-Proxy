import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  Send,
  Square,
  Trash2,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  SlidersHorizontal,
} from "lucide-react";
import type { BackendModelEntry, ChatMessageRecord, ChatSummary } from "./types";
import { BrandIcon } from "./BrandIcon";
import { Select } from "./Select";

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
      title: `Тест · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
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
    (m) => m.qualifiedId === modelId || m.gatewayId === modelId || m.nativeId === modelId
  );

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-60 shrink-0 border-r bg-[var(--bg-elevated)] flex flex-col">
        <div className="p-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--fg-muted)]">Локальные чаты</span>
          <button
            type="button"
            onClick={handleNewChat}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--accent)] px-2 text-[11px] font-medium text-[var(--accent-fg)] hover:opacity-90"
          >
            <Plus className="size-3.5" />
            <span>Новый</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {chats.length === 0 ? (
            <div className="p-4 text-center text-[11px] text-[var(--fg-subtle)]">
              Нет сохранённых чатов. Напишите сообщение или нажмите «Новый».
            </div>
          ) : (
            chats.map((c) => (
              <div
                key={c.id}
                onClick={() => setActiveChatId(c.id)}
                className={`group flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs cursor-pointer transition-colors ${
                  c.id === activeChatId
                    ? "bg-[var(--accent-soft)] text-[var(--fg)] font-medium"
                    : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MessageSquare className="size-3.5 shrink-0 opacity-70" />
                  <div className="min-w-0">
                    <div className="truncate">{c.title}</div>
                    <div className="text-[10px] text-[var(--fg-subtle)] truncate tabular-nums">
                      {c.messageCount} сообщ.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteChat(c.id);
                  }}
                  aria-label="Удалить чат"
                  className="opacity-0 group-hover:opacity-100 text-[var(--fg-subtle)] hover:text-[var(--danger)] p-0.5"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg)]">
        <div className="border-b bg-[var(--bg-elevated)] px-4 py-2.5 flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 flex-1 min-w-[240px]">
            <BrandIcon brand={selectedModelMeta?.brand ?? "devin"} size={18} />
            <Select
              value={modelId}
              onChange={setModelId}
              searchable
              searchPlaceholder="Поиск модели..."
              ariaLabel="Модель"
              placeholder="Выберите модель…"
              className="flex-1 min-w-0"
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
          </div>

          <Select
            value={effort}
            onChange={setEffort}
            ariaLabel="Уровень мышления"
            className="w-36"
            options={["none", "minimal", "low", "medium", "high", "xhigh", "max"].map((lvl) => ({
              value: lvl,
              label: `Effort: ${lvl}`,
            }))}
          />

          <Select
            value={protocol}
            onChange={setProtocol}
            ariaLabel="Протокол"
            className="w-28"
            options={[
              { value: "anthropic", label: "Anthropic" },
              { value: "openai", label: "OpenAI" },
            ]}
          />

          <button
            type="button"
            onClick={() => setShowSystem((v) => !v)}
            className={`inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs ${
              showSystem ? "bg-[var(--accent-soft)] border-[var(--accent)]" : "bg-[var(--bg)]"
            }`}
          >
            <SlidersHorizontal className="size-3" />
            <span>System</span>
          </button>
        </div>

        {showSystem && (
          <div className="border-b bg-[var(--bg-subtle)] px-4 py-2">
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Системные инструкции для этого тестового чата..."
              rows={2}
              className="w-full rounded-md border bg-[var(--bg)] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && !sending && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto gap-2 text-[var(--fg-muted)]">
              <BrandIcon brand={selectedModelMeta?.brand ?? "claude"} size={32} />
              <div className="text-sm font-medium text-[var(--fg)]">Песочница проверки моделей</div>
              <p className="text-xs text-pretty">
                Все сообщения сохраняются в локальную базу SQLite, а ответы измеряются по токенам, задержке и стоимости.
              </p>
            </div>
          )}

          {messages.map((m) => {
            const isUser = m.role === "user";
            const thinkOpen = openThinkIds[m.id] ?? showThinking;
            return (
              <div key={m.id} className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
                <div
                  className={`max-w-[82%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed ${
                    isUser
                      ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                      : "border bg-[var(--bg-elevated)] text-[var(--fg)]"
                  }`}
                >
                  {!isUser && m.thinking && (
                    <div className="mb-2 border-b pb-2">
                      <button
                        type="button"
                        onClick={() => setOpenThinkIds((p) => ({ ...p, [m.id]: !thinkOpen }))}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--fg-muted)] hover:text-[var(--fg)]"
                      >
                        {thinkOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        <span>Ход мыслей</span>
                      </button>
                      {thinkOpen && (
                        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-[var(--fg-muted)] leading-snug">
                          {m.thinking}
                        </pre>
                      )}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words text-pretty">{m.content}</div>
                </div>
                {!isUser && (
                  <div className="mt-1 flex items-center gap-2.5 text-[10px] text-[var(--fg-subtle)] tabular-nums px-1">
                    <span>{m.modelId}</span>
                    <span>· {m.inputTokens} in / {m.outputTokens} out ({m.usageSource === "measured" ? "точно" : "оценка"})</span>
                    <span>· {m.latencyMs} мс</span>
                    {m.costUsd > 0 && <span>· ${m.costUsd.toFixed(4)}</span>}
                  </div>
                )}
              </div>
            );
          })}

          {sending && (
            <div className="flex flex-col items-start">
              <div className="max-w-[82%] rounded-lg border bg-[var(--bg-elevated)] px-3.5 py-2.5 text-sm">
                {streamThinking && showThinking && (
                  <pre className="mb-2 border-b pb-2 whitespace-pre-wrap font-mono text-[11px] text-[var(--fg-muted)]">
                    {streamThinking}
                  </pre>
                )}
                <div className="whitespace-pre-wrap break-words">
                  {streamText || <span className="text-xs text-[var(--fg-subtle)]">Ожидание ответа модели...</span>}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </div>
          )}
        </div>

        <div className="border-t bg-[var(--bg-elevated)] p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Напишите тестовый запрос... (Enter отправить, Shift+Enter перенос)"
              rows={2}
              className="flex-1 resize-none rounded-md border bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            {sending ? (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex h-10 items-center gap-1.5 rounded-md bg-[var(--danger)] px-3.5 text-xs font-medium text-white hover:opacity-90"
              >
                <Square className="size-3.5 fill-current" />
                <span>Стоп</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className="inline-flex h-10 items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 text-xs font-medium text-[var(--accent-fg)] hover:opacity-90 disabled:opacity-40"
              >
                <Send className="size-3.5" />
                <span>Отправить</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

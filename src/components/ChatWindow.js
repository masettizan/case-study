import React, { useState, useEffect, useRef } from "react";
import "./ChatWindow.css";
import { getAIMessage } from "../api/api";
import { marked } from "marked";
import Widgets from "./Widgets";

const SUGGESTIONS = [
  "How can I install part number PS11752778?",
  "Is PS11756150 compatible with my WDT780SAEM1 model?",
  "The ice maker on my Whirlpool fridge is not working. How can I fix it?",
  "My dishwasher won't drain - what part do I need?",
];

function ChatWindow({ onReady }) {
  const defaultMessage = [
    {
      role: "assistant",
      content:
        "Hi! I'm the **PartSelect Assistant**. I can help you find refrigerator and " +
        "dishwasher parts, check if a part fits your model, walk you through installation, " +
        "and troubleshoot issues. What can I help you with?",
      widgets: [],
    },
  ];

  const [messages, setMessages] = useState(defaultMessage);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const messagesEndRef = useRef(null);
  const scrollToBottom = () =>
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const send = async (text) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed || loading) return;

    const userMsg = { role: "user", content: trimmed, widgets: [] };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setLoading(true);

    // Send full history so the agent keeps context across turns.
    const reply = await getAIMessage(history);
    setMessages((prev) => [...prev, reply]);
    setLoading(false);
  };

  // Expose send() to the parent (header "View cart" button) on each render so the
  // ref always points at the latest closure over messages/loading.
  useEffect(() => {
    onReady?.(send);
  });

  return (
    <div className="messages-container">
      {messages.map((message, index) => (
        <div key={index} className={`${message.role}-message-container`}>
          {message.content && (
            <div className={`message ${message.role}-message`}>
              <div
                dangerouslySetInnerHTML={{
                  __html: marked(message.content).replace(/<p>|<\/p>/g, ""),
                }}
              />
            </div>
          )}
          {message.role === "assistant" && (
            <Widgets widgets={message.widgets} onAction={send} />
          )}
        </div>
      ))}

      {loading && (
        <div className="assistant-message-container">
          <div className="message assistant-message">
            <span className="ps-typing"><span></span><span></span><span></span></span>
          </div>
        </div>
      )}

      {messages.length <= 1 && (
        <div className="ps-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="ps-suggestion" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div ref={messagesEndRef} />

      <div className="input-area">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about a fridge or dishwasher part..."
          onKeyPress={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              send();
              e.preventDefault();
            }
          }}
        />
        <button className="send-button" onClick={() => send()} disabled={loading}>
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatWindow;

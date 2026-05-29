// Frontend → backend bridge. Sends the full conversation so the agent has
// context across turns, and returns the assistant message plus any UI widgets
// (product cards, compatibility badges, cart) the agent attached.

const API_BASE = process.env.REACT_APP_API_BASE || "http://localhost:8000";

export const getAIMessage = async (messages) => {
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only send role/content the backend needs.
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) throw new Error(`Backend responded ${res.status}`);
    const data = await res.json();
    return {
      role: "assistant",
      content: data.content || "",
      widgets: data.widgets || [],
    };
  } catch (err) {
    console.error("getAIMessage error:", err);
    return {
      role: "assistant",
      content:
        "I couldn't reach the parts service. Make sure the backend is running " +
        "(`npm run server`) and try again.",
      widgets: [],
    };
  }
};

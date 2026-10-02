type MessageRole = "user" | "assistant";
type CivicAIMessage = { role: MessageRole; content: string };

const form = document.querySelector<HTMLFormElement>("#civicai-form");
const input = document.querySelector<HTMLTextAreaElement>("#civicai-input");
const sendButton = document.querySelector<HTMLButtonElement>("#civicai-send");
const messagesElement = document.querySelector<HTMLDivElement>("#civicai-messages");
const statusElement = document.querySelector<HTMLParagraphElement>("#civicai-status");

if (form && input && sendButton && messagesElement && statusElement) {
  const conversation: CivicAIMessage[] = [];
  let isSending = false;

  function addMessage(role: MessageRole, content: string): HTMLElement {
    const article = document.createElement("article");
    article.className = `civicai-message civicai-message-${role}`;

    const label = document.createElement("span");
    label.className = "civicai-message-label";
    label.textContent = role === "user" ? "YOU" : "CIVICAI";

    const text = document.createElement("p");
    text.textContent = content;

    article.append(label, text);
    messagesElement?.append(article);
    messagesElement?.scrollTo({ top: messagesElement.scrollHeight, behavior: "smooth" });
    return article;
  }

  function setStatus(message: string, state: "normal" | "error" = "normal"): void {
    statusElement!.textContent = message;
    statusElement!.dataset.state = state;
  }

  async function sendMessage(): Promise<void> {
    const content = input!.value.trim();
    if (!content || isSending) return;

    isSending = true;
    sendButton!.disabled = true;
    input!.disabled = true;
    setStatus("CivicAI is preparing a response…");

    conversation.push({ role: "user", content });
    const userBubble = addMessage("user", content);
    input!.value = "";

    try {
      const response = await fetch("/api/civicai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: conversation }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string"
            ? result.error
            : "CivicAI couldn't answer right now.";
        throw new Error(message);
      }
      if (
        typeof result !== "object" ||
        result === null ||
        !("answer" in result) ||
        typeof result.answer !== "string"
      ) {
        throw new Error("CivicAI returned an unexpected response.");
      }

      conversation.push({ role: "assistant", content: result.answer });
      addMessage("assistant", result.answer);
      setStatus("General information only. Check important details with an official local source.");
    } catch (error) {
      conversation.pop();
      userBubble.remove();
      input!.value = content;
      setStatus(
        error instanceof Error ? error.message : "CivicAI couldn't answer right now.",
        "error",
      );
    } finally {
      isSending = false;
      sendButton!.disabled = false;
      input!.disabled = false;
      input!.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}
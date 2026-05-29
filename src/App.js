import React, { useRef } from "react";
import "./App.css";
import ChatWindow from "./components/ChatWindow";

function App() {
  // ChatWindow registers its send() here so the header can push a chat message
  // (e.g. "View my cart") without lifting all of ChatWindow's state up.
  const sendRef = useRef(null);

  return (
    <div className="App">
      <header className="heading">
        <div className="brand">
          <span className="brand-mark">PartSelect</span>
          <span className="brand-sub">Assistant</span>
        </div>
        <div className="brand-right">
          <span className="brand-scope">Refrigerator &amp; Dishwasher Parts</span>
          <button
            className="brand-cart"
            onClick={() => sendRef.current?.("View my cart")}
          >
            View cart
          </button>
          <a
            className="brand-home"
            href="https://www.partselect.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Visit PartSelect.com
          </a>
        </div>
      </header>
      <ChatWindow onReady={(send) => { sendRef.current = send; }} />
    </div>
  );
}

export default App;

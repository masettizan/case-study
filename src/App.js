import React from "react";
import "./App.css";
import ChatWindow from "./components/ChatWindow";

function App() {
  return (
    <div className="App">
      <header className="heading">
        <div className="brand">
          <span className="brand-mark">PartSelect</span>
          <span className="brand-sub">Assistant</span>
        </div>
        <div className="brand-right">
          <span className="brand-scope">Refrigerator &amp; Dishwasher Parts</span>
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
      <ChatWindow />
    </div>
  );
}

export default App;

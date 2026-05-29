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
        <div className="brand-scope">Refrigerator &amp; Dishwasher Parts</div>
      </header>
      <ChatWindow />
    </div>
  );
}

export default App;

// Rich inline UI the agent can attach to a message. Each widget type maps to a
// payload shape emitted by a backend tool handler (server/tools.js). `onAction`
// lets a card push a follow-up message into the chat (e.g. "Add PS… to cart").

import React from "react";

const Stars = ({ rating, reviewCount }) => (
  <span className="ps-stars" title={`${rating} / 5`}>
    {"★".repeat(Math.round(rating))}
    {"☆".repeat(5 - Math.round(rating))}
    {reviewCount != null && <span className="ps-reviews"> ({reviewCount})</span>}
  </span>
);

const Stock = ({ inStock }) => (
  <span className={`ps-stock ${inStock ? "in" : "out"}`}>
    {inStock ? "In Stock" : "Out of Stock"}
  </span>
);

function ProductCard({ part, onAction }) {
  return (
    <div className="ps-card">
      <div className="ps-card-body">
        <div className="ps-card-title">{part.name}</div>
        <div className="ps-card-meta">
          <span className="ps-badge">{part.partSelectNumber}</span>
          <span className="ps-muted">{part.brand} · {part.appliance}</span>
        </div>
        {part.rating != null && <Stars rating={part.rating} reviewCount={part.reviewCount} />}
        <div className="ps-card-row">
          {part.price != null && (
            <span className="ps-price">${part.price?.toFixed ? part.price.toFixed(2) : part.price}</span>
          )}
          {part.inStock != null && <Stock inStock={part.inStock} />}
        </div>
        <div className="ps-card-actions">
          {part.url && (
            <a className="ps-btn" href={part.url} target="_blank" rel="noreferrer">
              View part
            </a>
          )}
          <button
            className="ps-btn ghost"
            onClick={() => onAction(`How do I install ${part.partSelectNumber}?`)}
          >
            Install guide
          </button>
        </div>
      </div>
    </div>
  );
}

function CompatibilityWidget({ w, onAction }) {
  return (
    <div className={`ps-compat ${w.compatible ? "yes" : "no"}`}>
      <div className="ps-compat-head">
        {w.compatible ? "✓ Compatible" : "⚠ Not a verified fit"}
      </div>
      <div className="ps-compat-body">
        <strong>{w.partName}</strong> ({w.partNumber}) {w.compatible ? "fits" : "is not confirmed for"} model{" "}
        <strong>{w.modelNumber}</strong>.
      </div>
      {w.part && <ProductCard part={w.part} onAction={onAction} />}
    </div>
  );
}

function InstallGuide({ w }) {
  const timeLabel = w.estimatedTime || (w.estimatedTimeMins != null ? `~${w.estimatedTimeMins} min` : null);
  return (
    <div className="ps-guide">
      <div className="ps-guide-head">
        🔧 Install: {w.partName} <span className="ps-badge">{w.partNumber}</span>
      </div>
      <div className="ps-guide-meta">
        {w.difficulty && <span className="ps-chip">{w.difficulty}</span>}
        {timeLabel && <span className="ps-chip">{timeLabel}</span>}
        {w.videoUrl && (
          <a className="ps-chip link" href={w.videoUrl} target="_blank" rel="noreferrer">▶ Video</a>
        )}
      </div>
      {w.tools?.length > 0 && (
        <div className="ps-guide-tools">
          🛠 Tools: {w.tools.join(", ")}
        </div>
      )}
      {w.steps?.length > 0 && (
        <ol className="ps-steps">
          {w.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

function CartWidget({ w }) {
  return (
    <div className="ps-cart">
      <div className="ps-cart-head">🛒 Cart · {w.itemCount} item{w.itemCount === 1 ? "" : "s"}</div>
      {w.items?.length ? (
        <>
          <ul className="ps-cart-list">
            {w.items.map((i) => (
              <li key={i.partSelectNumber}>
                <span>{i.quantity}× {i.name}</span>
                <span className="ps-muted">${i.lineTotal.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <div className="ps-cart-total"><span>Total</span><strong>${w.total.toFixed(2)}</strong></div>
          <button className="ps-btn full">Checkout</button>
        </>
      ) : (
        <div className="ps-muted">Your cart is empty.</div>
      )}
    </div>
  );
}

export default function Widgets({ widgets, onAction }) {
  if (!widgets || !widgets.length) return null;
  return (
    <div className="ps-widgets">
      {widgets.map((w, i) => {
        switch (w.type) {
          case "product_list":
            return (
              <div className="ps-widget-block" key={i}>
                {w.title && <div className="ps-widget-title">{w.title}</div>}
                <div className="ps-card-grid">
                  {w.parts.map((p) => <ProductCard key={p.partSelectNumber} part={p} onAction={onAction} />)}
                </div>
              </div>
            );
          case "product_card":
            return <ProductCard key={i} part={w.part} onAction={onAction} />;
          case "compatibility":
            return <CompatibilityWidget key={i} w={w} onAction={onAction} />;
          case "install_guide":
            return <InstallGuide key={i} w={w} />;
          case "cart":
            return <CartWidget key={i} w={w} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

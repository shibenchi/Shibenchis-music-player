import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from 'react-bootstrap';
import { getUiScale } from './uiScale';

// the "change layout" window: a stand-in for each panel of a tab, that can be moved around. the real tab is laid out that way once it is
// saved.
//
// on a computer the panels are in two columns and the stand-ins are too. on a phone the page is one column and the panels only have an
// order, so the stand-ins are one list in that order and nothing here moves a panel to the other column (the columns do not exist there).
//
// dragging is done with pointer events (mouse, pen and finger alike) and not with the browser's drag and drop. the desktop app's
// window eats the browser's drops on Windows, so a tile could be picked up and never put down. here the pointer is followed by hand:
// press on a tile, move a few pixels, a copy of the tile follows the pointer and a bar shows where it will go, let go to put it there.
// the buttons on every tile do the same without dragging

const TABS = [['main', 'home'], ['social', 'social'], ['collab', 'collab']];
const START_PX = 5;
const NARROW_QUERY = '(max-width: 720px)';

// the same width the stylesheet calls a phone (the columns of the tabs stack there)
function useNarrow() {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const change = () => setNarrow(query.matches);
    change();
    if (query.addEventListener) query.addEventListener('change', change); else query.addListener(change);
    return () => { if (query.removeEventListener) query.removeEventListener('change', change); else query.removeListener(change); };
  }, []);
  return narrow;
}

export default function LayoutEditor({ show, onHide, draft, tab, onTab, labels, onMove, onSide, onPlace, onReset, onSave }) {
  // the drag in progress: null, or { id, x, y, offX, offY, width, height, side, beforeId }
  const [drag, setDrag] = useState(null);
  const narrow = useNarrow();
  // pointer positions are in screen pixels, the dragged copy is placed in interface pixels (they differ when the ui size is not 100%)
  const uiZoom = getUiScale() || 1;
  const tileRefs = useRef({});
  const columnRefs = useRef({});
  const part = draft ? draft[tab] : null;
  // what the handlers below read, they live longer than one render
  const live = useRef({});
  live.current = { part, tab, onPlace, narrow };

  const sideOf = (id) => (part.sides[id] === 'right' ? 'right' : 'left');
  const columnIds = (side) => (part ? part.order.filter((id) => (part.sides[id] === 'right') === (side === 'right')) : []);

  // where a dragged tile would go: the column the pointer is over (the nearer one when it is outside both) and the tile it would go in
  // front of. on a phone there is one list and a tile keeps its column
  const locate = (x, y, dragId) => {
    const current = live.current.part;
    const before = (ids) => {
      for (let i = 0; i < ids.length; i += 1) {
        const el = tileRefs.current[ids[i]];
        if (!el) continue;
        const box = el.getBoundingClientRect();
        if (y < box.top + box.height / 2) return ids[i];
      }
      return null;
    };
    if (live.current.narrow) {
      return { side: current.sides[dragId] === 'right' ? 'right' : 'left', beforeId: before(current.order.filter((id) => id !== dragId)) };
    }
    const rects = {};
    ['left', 'right'].forEach((side) => {
      const el = columnRefs.current[side];
      if (el) rects[side] = el.getBoundingClientRect();
    });
    let side = 'left';
    if (rects.left && rects.right) {
      if (x >= rects.left.left && x <= rects.left.right) side = 'left';
      else if (x >= rects.right.left && x <= rects.right.right) side = 'right';
      else side = x < (rects.left.right + rects.right.left) / 2 ? 'left' : 'right';
    }
    return { side, beforeId: before(current.order.filter((id) => id !== dragId && (current.sides[id] === 'right') === (side === 'right'))) };
  };

  const pressTile = (event, id) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest && event.target.closest('button')) return;
    const el = tileRefs.current[id];
    if (!el) return;
    const box = el.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const base = { id, offX: event.clientX - box.left, offY: event.clientY - box.top, width: box.width, height: box.height };
    let started = false;

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    function move(e) {
      if (!started) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < START_PX) return;
        started = true;
      }
      e.preventDefault();
      const where = locate(e.clientX, e.clientY, id);
      setDrag({ ...base, x: e.clientX, y: e.clientY, side: where.side, beforeId: where.beforeId });
    }
    function up(e) {
      stop();
      setDrag(null);
      if (!started) return;
      const where = locate(e.clientX, e.clientY, id);
      live.current.onPlace(live.current.tab, id, where.beforeId, where.side);
    }
    function cancel() {
      stop();
      setDrag(null);
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // the window closing (or the tab changing) in the middle of a drag drops it
  useEffect(() => { setDrag(null); }, [show, tab]);

  const tile = (id, columnSide) => {
    const side = sideOf(id);
    const lifted = drag && drag.id === id;
    const dropHere = drag && drag.beforeId === id && (narrow || drag.side === columnSide);
    return (
      <React.Fragment key={id}>
        {dropHere && <div className="le-drop" />}
        <div
          className={`le-tile${lifted ? ' le-lifted' : ''}`}
          ref={(el) => { if (el) tileRefs.current[id] = el; else delete tileRefs.current[id]; }}
          onPointerDown={(event) => pressTile(event, id)}
        >
          <span className="le-name">{labels[id][0]}</span>
          <span className="le-buttons">
            <button type="button" className="le-small" onClick={() => onMove(tab, id, -1, narrow)}>up</button>
            <button type="button" className="le-small" onClick={() => onMove(tab, id, 1, narrow)}>down</button>
            {!narrow && (
              <button type="button" className="le-small" onClick={() => onSide(tab, id, side === 'left' ? 'right' : 'left')}>{side === 'left' ? 'right' : 'left'}</button>
            )}
          </span>
        </div>
      </React.Fragment>
    );
  };

  const column = (side) => {
    const ids = columnIds(side);
    return (
      <div className="le-column" ref={(el) => { columnRefs.current[side] = el; }}>
        <div className="le-column-name">{side}</div>
        {ids.map((id) => tile(id, side))}
        {drag && drag.side === side && drag.beforeId === null && <div className="le-drop" />}
      </div>
    );
  };

  const ghost = drag && part && labels[drag.id] ? createPortal(
    <div className="le-ghost" style={{ left: (drag.x - drag.offX) / uiZoom, top: (drag.y - drag.offY) / uiZoom, width: drag.width / uiZoom, height: drag.height / uiZoom }}>
      <span className="le-name">{labels[drag.id][0]}</span>
    </div>,
    document.body
  ) : null;

  return (
    <Modal show={show} onHide={onHide} centered size="lg" className="settings-modal layout-editor" animation={false}>
      <Modal.Header closeButton>
        <Modal.Title>change layout</Modal.Title>
      </Modal.Header>
      <Modal.Body className={drag ? 'le-dragging' : ''}>
        {part && (
          <>
            <div className="le-tabs">
              {TABS.map(([key, label]) => (
                <button key={key} type="button" className={`le-tab${tab === key ? ' le-on' : ''}`} onClick={() => onTab(key)}>{label}</button>
              ))}
            </div>
            {narrow ? (
              <div className="le-list">
                {part.order.map((id) => tile(id, null))}
                {drag && drag.beforeId === null && <div className="le-drop" />}
              </div>
            ) : (
              <div className="le-columns">
                {column('left')}
                {column('right')}
              </div>
            )}
            <div className="le-footer">
              <button type="button" className="le-button" onClick={() => onReset(tab)}>reset this tab</button>
              <span className="le-spacer" />
              <button type="button" className="le-button" onClick={onHide}>cancel</button>
              <button type="button" className="le-button le-save" onClick={onSave}>save layout</button>
            </div>
          </>
        )}
        {ghost}
      </Modal.Body>
    </Modal>
  );
}

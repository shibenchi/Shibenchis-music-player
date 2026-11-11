import React from 'react';
import { Modal } from 'react-bootstrap';
import { agoText } from './undoHistory';

// the list of recent changes (settings, "recent changes"): what was removed, cleared, renamed or added, newest first, each with a button that
// takes it back. a change that was already taken back leaves the list
export default function ChangesModal({ show, onHide, entries, onUndo }) {
  return (
    <Modal show={show} onHide={onHide} centered size="lg" className="settings-modal layout-editor changes-modal" animation={false}>
      <Modal.Header closeButton>
        <Modal.Title>recent changes</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="ch-list" data-changes-list>
          {entries.length === 0 ? (
            <div className="ch-empty">nothing yet</div>
          ) : entries.map((entry) => (
            <div className="ch-row" key={entry.id} data-change-row={entry.kind}>
              <span className="ch-label">{entry.label}</span>
              <span className="ch-time">{agoText(entry.at)}</span>
              <button type="button" className="le-small" data-change-undo onClick={() => onUndo(entry.id)}>undo</button>
            </div>
          ))}
        </div>
      </Modal.Body>
    </Modal>
  );
}

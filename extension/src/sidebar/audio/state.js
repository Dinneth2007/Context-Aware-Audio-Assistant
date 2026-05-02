// Explicit state machine for the audio loop. Single source of truth for
// what the UI is doing, with side effects encoded in transition().
//
// states:       'idle' | 'listening' | 'thinking' | 'speaking'
// transitions:  see ALLOWED below.

import { useEffect, useState } from 'react';
import * as tts from './tts.js';

const ALLOWED = {
  idle:      ['listening', 'thinking'],
  listening: ['thinking', 'idle', 'listening'],
  thinking:  ['speaking', 'idle', 'listening'],
  speaking:  ['idle', 'listening'],
};

let state = 'idle';
const subscribers = new Set();

let abortRef = { current: null };
let sttRef = { current: null };

function emit() { for (const fn of subscribers) { try { fn(state); } catch {} } }

function leave(from) {
  if (from === 'listening' && sttRef.current) {
    try { sttRef.current.stop(); } catch {}
  }
}

function enter(next, _prev) {
  if (next === 'listening') {
    tts.cancel();
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} ; abortRef.current = null; }
    if (sttRef.current) { try { sttRef.current.start(); } catch {} }
  }
  if (next === 'idle') {
    tts.cancel();
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} ; abortRef.current = null; }
    if (sttRef.current) { try { sttRef.current.stop(); } catch {} }
  }
  if (next === 'thinking') {
    if (sttRef.current) { try { sttRef.current.stop(); } catch {} }
  }
}

export function getState() { return state; }

export function transition(next) {
  if (state === next) return state;
  const allowed = ALLOWED[state] || [];
  if (!allowed.includes(next)) {
    console.warn(`[wubble state] illegal transition ${state} → ${next}`);
    return state;
  }
  const prev = state;
  leave(prev);
  state = next;
  enter(next, prev);
  emit();
  return state;
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn(state);
  return () => subscribers.delete(fn);
}

export function bindAbortController(ac) {
  abortRef.current = ac;
}

export function bindSTT(stt) {
  sttRef.current = stt;
}

export function clearAbortController() {
  abortRef.current = null;
}

export function useAudioState() {
  const [s, setS] = useState(state);
  useEffect(() => subscribe(setS), []);
  return { state: s, transition };
}

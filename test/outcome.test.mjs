import assert from 'node:assert/strict'
import test from 'node:test'

import { outcomeOf } from '../lib/index.js'

const start = (seq, time) => ({ type: 'turn/start', seq, time })
const end = (seq, time, reason) => ({ type: 'turn/end', seq, time, data: { reason } })

test('completed turn is not a failure', () => {
  assert.deepEqual(outcomeOf([start(1, 10), end(9, 20, { kind: 'completed' })]), {
    state: 'completed',
    failed: false,
    at: 20,
  })
})

test('error turn carries the provider message and code', () => {
  assert.deepEqual(
    outcomeOf([start(1, 10), end(9, 20, { kind: 'error', error: { message: 'Connection error.', code: 'X' } })]),
    { state: 'error', failed: true, at: 20, message: 'Connection error.', code: 'X' },
  )
})

test('unterminated latest turn is an interrupted run', () => {
  assert.deepEqual(outcomeOf([start(5, 10), { type: 'assistant/message', seq: 6, time: 11 }]), {
    state: 'interrupted',
    failed: true,
    at: 10,
  })
})

test('a new turn opened after a closed one is interrupted', () => {
  assert.deepEqual(outcomeOf([start(1, 10), end(9, 20, { kind: 'completed' }), start(10, 30)]), {
    state: 'interrupted',
    failed: true,
    at: 30,
  })
})

test('max-tokens counts as failure, abort does not', () => {
  assert.equal(outcomeOf([start(1, 10), end(9, 20, { kind: 'max-tokens' })]).failed, true)
  assert.equal(
    outcomeOf([start(1, 10), end(9, 20, { kind: 'aborted', reason: { kind: 'user' } })]).failed,
    false,
  )
})

test('an empty log has no outcome', () => {
  assert.deepEqual(outcomeOf([]), { state: 'empty' })
})

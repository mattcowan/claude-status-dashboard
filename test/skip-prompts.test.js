'use strict';

// Regression tests for the skip list (lib/skip-prompts.js).
//
// Two things here are easy to break by accident and expensive to notice:
//
//   1. Which commands are skipped. Dropping one silently puts bookkeeping
//      sessions back on the board; adding one silently hides real work.
//   2. What counts as "the invocation and nothing more". This matcher was
//      tightened once already (6748ca1) after the expanded-form check matched
//      `<command-name>` as a substring anywhere in the prompt, so a code review
//      that merely *quoted* the tag got skipped as bookkeeping. Every negative
//      case below is a way that failure could come back.
//
// Run with `npm test`.
//
// Deliberately hermetic: the matcher cases are driven off whatever commands()
// currently returns rather than off a hardcoded name, so a machine with its own
// data/skip-prompts.json override still runs a meaningful suite instead of
// failing on someone else's config. Only the DEFAULT_COMMANDS test asserts
// specific names, and that one reads the constant directly without touching the
// override file at all.

const test = require('node:test');
const assert = require('node:assert');

const skip = require('../lib/skip-prompts');

test('DEFAULT_COMMANDS pins the shipped skip list', () => {
  assert.ok(
    skip.DEFAULT_COMMANDS.includes('git-commit-message'),
    'git-commit-message must stay on the shipped skip list'
  );
  assert.ok(
    skip.DEFAULT_COMMANDS.includes('git-review'),
    'git-review must stay on the shipped skip list'
  );
});

test('commands() returns bare names, no leading slash', () => {
  for (const name of skip.commands()) {
    assert.ok(name && typeof name === 'string', 'entries are non-empty strings');
    assert.ok(!name.startsWith('/'), `"${name}" should have been normalized`);
  }
});

// Every configured command must behave identically, so the suite can't pass by
// covering only the first entry.
for (const cmd of skip.commands()) {
  test(`/${cmd}: bare invocations are skipped`, () => {
    assert.strictEqual(skip.match(`/${cmd}`), cmd);
    assert.strictEqual(skip.match(`  /${cmd}  `), cmd, 'surrounding whitespace');
    assert.strictEqual(skip.match(`/${cmd} --no-cosign`), cmd, 'trailing args');
    assert.strictEqual(skip.match(`/${cmd}\t--flag`), cmd, 'tab-separated args');

    // Known, accepted ambiguity: on a SINGLE line there is nothing to
    // distinguish arguments from prose, so anything after the command reads as
    // arguments and the prompt is skipped. `/cmd can you also check X` is
    // therefore a false negative — no card. The escape hatch is a newline,
    // which is what the "real work" cases below rely on. Pinned here so the
    // trade-off is visible rather than discovered.
    assert.strictEqual(
      skip.match(`/${cmd} is what I want you to change`),
      cmd,
      'trailing prose on one line is indistinguishable from args'
    );
  });

  test(`/${cmd}: the expanded transcript form is skipped`, () => {
    assert.strictEqual(
      skip.match(`<command-message>${cmd}</command-message>\n<command-name>/${cmd}</command-name>`),
      cmd
    );
    assert.strictEqual(
      skip.match(
        `<command-name>/${cmd}</command-name>\n<command-args>--no-cosign</command-args>`
      ),
      cmd,
      'a <command-args> line is still just the invocation'
    );
  });

  test(`/${cmd}: real work is never skipped`, () => {
    const cases = {
      'invocation then prose on a later line': `/${cmd}\nalso fix the tax bug`,
      'invocation then a blank line then prose': `/${cmd}\n\nand update the README`,
      'mentioned mid-sentence': `can you look at /${cmd} for me`,
      'longer command with the same prefix': `/${cmd}er`,
      'hyphen-suffixed sibling': `/${cmd}-v2`,
      // The 6748ca1 regression: quoting the wrapper inside prose.
      'expanded tag quoted inside prose': `I reviewed <command-name>/${cmd}</command-name> in the docs\nand it needs work`,
      'expanded tag plus a prose line': `<command-name>/${cmd}</command-name>\nnow do the refactor`,
      // A newline can never sit inside a wrapper: the tag must close on its line.
      'wrapper broken across lines': `<command-name>/${cmd}\n</command-name>`,
      'unclosed wrapper': `<command-name>/${cmd}`,
      'unknown wrapper shape': `<command-thing>/${cmd}</command-thing>`,
    };
    for (const [label, prompt] of Object.entries(cases)) {
      assert.strictEqual(skip.match(prompt), '', `should be real work: ${label}`);
    }
  });
}

test('non-prompts and unknown commands are never skipped', () => {
  for (const prompt of ['', '   ', '\n', null, undefined, 42, {}, [], '/post-status', '/status']) {
    assert.strictEqual(skip.match(prompt), '', `should be real work: ${JSON.stringify(prompt)}`);
  }
});

// Regression for the "second door": bin/status.js's set/note/needs-input/
// done-for-review subcommands reach the same card-creating server endpoint as
// the UserPromptSubmit hook, but through resolveOrCreateSession() rather than
// the hook's own skip.match() check. server.js closes that gap by asking
// hasPendingSkip() before creating any *new* card. This pins the marker
// lifecycle that check depends on: present after record(), gone after
// takeRecord() — the same consume-on-real-prompt sequence hookUserPrompt()
// relies on to distinguish "real prompt POST" from "bookkeeping CLI POST".
test('hasPendingSkip reflects the record/takeRecord lifecycle', () => {
  const sessionId = 'test-hasPendingSkip-' + process.pid;
  assert.strictEqual(skip.hasPendingSkip(sessionId), false, 'no marker before any skip is recorded');

  skip.record(sessionId, 'git-review');
  assert.strictEqual(skip.hasPendingSkip(sessionId), true, 'marker present after a skip is recorded');

  const rec = skip.takeRecord(sessionId);
  assert.ok(rec && rec.count === 1, 'takeRecord returns what was recorded');
  assert.strictEqual(skip.hasPendingSkip(sessionId), false, 'marker consumed after takeRecord');
});

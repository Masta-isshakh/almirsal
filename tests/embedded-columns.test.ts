import { describe, expect, it } from 'vitest';

/**
 * `column_invisible` on an embedded list is written against the parent record
 * (`parent.state != 'sale'`), and the renderer strips that prefix before it
 * evaluates the condition. The regex that strips it held a backspace character
 * instead of `\b` for a while, so the prefix stayed and every such column was
 * judged on an expression that could not resolve — this keeps the pattern
 * honest.
 */
const STRIP_PARENT = /\bparent\./g;

describe('the parent prefix of an embedded column', () => {
  it('comes off wherever it appears', () => {
    expect("parent.state != 'sale'".replace(STRIP_PARENT, '')).toBe("state != 'sale'");
    expect('not parent.require_signature'.replace(STRIP_PARENT, '')).toBe('not require_signature');
    expect("parent.move_type in ('out_invoice',) and parent.state == 'draft'".replace(STRIP_PARENT, ''))
      .toBe("move_type in ('out_invoice',) and state == 'draft'");
  });

  it('leaves a field that merely contains the word alone', () => {
    expect('grandparent.state'.replace(STRIP_PARENT, '')).toBe('grandparent.state');
    expect('parent_id != False'.replace(STRIP_PARENT, '')).toBe('parent_id != False');
    expect('transparent.value'.replace(STRIP_PARENT, '')).toBe('transparent.value');
  });

  it('is a real word boundary, not a stray control character', () => {
    // A backspace in the pattern matched nothing, which is how the bug hid.
    expect(STRIP_PARENT.source).toBe('\\bparent\\.');
    expect(STRIP_PARENT.source).not.toContain(String.fromCharCode(8));
  });
});

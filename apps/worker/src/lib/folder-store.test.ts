import { describe, it, expect } from 'vitest';
import { FolderValidationError, validateFolderInput } from './folder-store.js';

describe('validateFolderInput', () => {
  const base = {
    parent_id: null,
    name: 'Catalogs',
    visibility_mode: 'all_b2b' as const,
  };

  it('accepts a minimal valid root folder', () => {
    const out = validateFolderInput(base);
    expect(out.name).toBe('Catalogs');
    expect(out.parent_id).toBeNull();
  });

  it('trims the name', () => {
    expect(validateFolderInput({ ...base, name: '  Trimmed  ' }).name).toBe('Trimmed');
  });

  it('rejects an empty name', () => {
    expect(() => validateFolderInput({ ...base, name: '' })).toThrow(FolderValidationError);
    expect(() => validateFolderInput({ ...base, name: '   ' })).toThrow(FolderValidationError);
  });

  it('rejects an over-long name', () => {
    expect(() => validateFolderInput({ ...base, name: 'a'.repeat(101) })).toThrow(
      FolderValidationError,
    );
  });

  it('rejects an unknown visibility_mode', () => {
    expect(() => validateFolderInput({ ...base, visibility_mode: 'public' })).toThrow(
      FolderValidationError,
    );
  });

  it('rejects a non-positive parent_id', () => {
    expect(() => validateFolderInput({ ...base, parent_id: 0 })).toThrow(
      FolderValidationError,
    );
    expect(() => validateFolderInput({ ...base, parent_id: -3 })).toThrow(
      FolderValidationError,
    );
  });

  it('accepts an integer parent_id', () => {
    expect(validateFolderInput({ ...base, parent_id: 7 }).parent_id).toBe(7);
  });
});

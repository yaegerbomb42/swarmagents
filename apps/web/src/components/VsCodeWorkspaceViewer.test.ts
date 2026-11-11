import { describe, it, expect } from 'vitest';
import { buildFileTree } from './VsCodeWorkspaceViewer';

describe('VsCodeWorkspaceViewer', () => {
  it('correctly constructs nested directories and sorts folders before files', () => {
    const fileList = [
      'package.json',
      'src/index.ts',
      'src/auth/TokenService.ts',
      'deliverables/task-1.md',
    ];

    const tree = buildFileTree(fileList);
    expect(tree).toBeDefined();
    expect(tree['']).toContain('package.json');
    expect(tree['']).toContain('src/');
    expect(tree['']).toContain('deliverables/');
    expect(tree['src']).toContain('auth/');
    expect(tree['src']).toContain('index.ts');
    expect(tree['src/auth']).toContain('TokenService.ts');
  });
});

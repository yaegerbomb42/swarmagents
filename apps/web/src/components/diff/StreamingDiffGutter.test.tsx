import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StreamingDiffGutter from './StreamingDiffGutter';

const SAMPLE = `--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-const old = 1;
+const next = 2;
 context line
`;

describe('StreamingDiffGutter', () => {
  it('renders side-by-side gutter with approve actions', () => {
    render(<StreamingDiffGutter filename="foo.ts" diffText={SAMPLE} />);
    expect(screen.getByTestId('streaming-diff-gutter')).toBeDefined();
    expect(screen.getByText('Before')).toBeDefined();
    expect(screen.getByText('After')).toBeDefined();
    expect(screen.getByText('Approve')).toBeDefined();
    expect(screen.getByText('const old = 1;')).toBeDefined();
    expect(screen.getByText('const next = 2;')).toBeDefined();
  });
});

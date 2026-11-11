'use client';

import React from 'react';
import VsCodeWorkspaceViewer from './VsCodeWorkspaceViewer';

type Props = {
  sessionId: string | null;
  className?: string;
  pollMs?: number;
  initialPath?: string | null;
};

export default function WorkspaceIDE(props: Props) {
  return <VsCodeWorkspaceViewer {...props} />;
}

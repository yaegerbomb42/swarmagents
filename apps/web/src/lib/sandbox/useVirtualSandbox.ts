'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VirtualVM } from './virtualVm';
import type { SandboxEvent, VfsFileStatus } from './virtualVm';

export interface VirtualSandboxApi {
  terminalLogs: SandboxEvent[];
  activeCommand: string | null;
  vfsFiles: VfsFileStatus[];
  runCommand: (cmd: string) => Promise<number>;
  clear: () => void;
}

/**
 * One VirtualVM per hook instance (useRef), so multiple sandbox widgets
 * on a dashboard keep independent filesystems.
 */
export function useVirtualSandbox(): VirtualSandboxApi {
  const vmRef = useRef<VirtualVM | null>(null);
  if (vmRef.current === null) vmRef.current = new VirtualVM();
  const vm = vmRef.current;

  const [terminalLogs, setTerminalLogs] = useState<SandboxEvent[]>([]);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [vfsFiles, setVfsFiles] = useState<VfsFileStatus[]>(() => vm.listFiles());

  useEffect(() => {
    return vm.on((event) => {
      setTerminalLogs((prev) => [...prev, event]);
    });
  }, [vm]);

  const runCommand = useCallback(
    async (cmd: string): Promise<number> => {
      setActiveCommand(cmd);
      try {
        return await vm.run(cmd);
      } finally {
        setActiveCommand(null);
        setVfsFiles(vm.listFiles());
      }
    },
    [vm],
  );

  const clear = useCallback(() => {
    setTerminalLogs([]);
  }, []);

  return { terminalLogs, activeCommand, vfsFiles, runCommand, clear };
}

import type { Metadata } from 'next';
import OmnexxConsole from '@/components/console/OmnexxConsole';

export const metadata: Metadata = {
  title: 'Console · SwarmAgents',
  description: 'Dispatch a goal to the Omnexx engine and watch it run live.',
};

export default function ConsolePage() {
  return <OmnexxConsole />;
}

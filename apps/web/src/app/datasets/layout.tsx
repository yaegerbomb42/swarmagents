import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Synthetic Post-Training Reasoning Datasets (210k+ Trajectories) — SwarmAgents',
  description:
    'Download enterprise-grade multi-turn synthetic reasoning datasets, Rust/eBPF systems trajectories, and full-stack software engineering datasets for fine-tuning LLMs.',
  keywords: [
    'synthetic datasets',
    'AI training data',
    'fine-tuning dataset',
    'reasoning trajectories',
    'synthetic data for LLMs',
    'coding dataset jsonl',
    'Rust eBPF training data',
    'agentic multi-turn dataset',
    'buy AI datasets',
    'post-training datasets'
  ],
  openGraph: {
    title: 'Synthetic Reasoning & Systems Datasets (210k+ Trajectories)',
    description: 'Enterprise synthetic reasoning datasets for fine-tuning frontier coding & systems AI models. Instant high-speed fiber downloads.',
    url: 'https://swarmagents.codes/datasets',
    siteName: 'SwarmAgents',
    images: [
      {
        url: 'https://swarmagents.codes/brand/icon.png',
        width: 1200,
        height: 630,
        alt: 'SwarmAgents Synthetic Datasets',
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Synthetic Reasoning & Systems Datasets (210k+ Trajectories)',
    description: 'Enterprise synthetic reasoning datasets for fine-tuning frontier coding & systems AI models.',
    images: ['https://swarmagents.codes/brand/icon.png'],
  },
  alternates: {
    canonical: 'https://swarmagents.codes/datasets',
  },
};

export default function DatasetsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Dataset',
            name: 'SwarmAgents 210k Master Synthetic Reasoning & Systems Dataset',
            description: 'Enterprise synthetic reasoning trajectories, lock-free Rust/eBPF systems code, full-stack migrations, and agentic multi-turn trajectories for LLM post-training.',
            url: 'https://swarmagents.codes/datasets',
            license: 'https://swarmagents.codes/terms',
            creator: {
              '@type': 'Organization',
              name: 'SwarmAgents',
              url: 'https://swarmagents.codes',
            },
            distribution: [
              {
                '@type': 'DataDownload',
                encodingFormat: 'application/gzip',
                contentUrl: 'https://swarmagents.codes/api/datasets/download?sku=master-210k',
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}

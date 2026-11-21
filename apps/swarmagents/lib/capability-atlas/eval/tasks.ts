export interface EvalTask {
  query: string;
  expectedIds: string[];
}

export const EVAL_TASKS: EvalTask[] = [
  { query: "render a .blend to mp4", expectedIds: ["cli:blender", "cli:ffmpeg"] },
  { query: "open a GitHub PR", expectedIds: ["cli:gh", "mcp:github:tool:create_pull_request"] },
  { query: "transcribe audio", expectedIds: ["cli:whisper"] },
  { query: "convert docx to pdf", expectedIds: ["cli:pandoc", "cli:soffice"] },
  { query: "resize and crop a PNG image", expectedIds: ["cli:magick", "cli:convert"] },
  { query: "download a YouTube video", expectedIds: ["cli:yt-dlp"] },
  { query: "extract text from a scanned image OCR", expectedIds: ["cli:tesseract"] },
  { query: "extract plain text from a PDF", expectedIds: ["cli:pdftotext"] },
  { query: "merge and split PDF files", expectedIds: ["cli:qpdf", "cli:gs"] },
  { query: "search code with regex recursively", expectedIds: ["cli:rg"] },
  { query: "filter and transform JSON output", expectedIds: ["cli:jq"] },
  { query: "edit a YAML config file", expectedIds: ["cli:yq"] },
  { query: "query a local SQLite database", expectedIds: ["cli:sqlite3"] },
  { query: "run analytical SQL on Parquet and CSV", expectedIds: ["cli:duckdb"] },
  { query: "run SQL query on PostgreSQL", expectedIds: ["cli:psql", "mcp:postgres:tool:query"] },
  { query: "build and run a Docker container", expectedIds: ["cli:docker"] },
  { query: "inspect Kubernetes pods and logs", expectedIds: ["cli:kubectl"] },
  { query: "provision cloud infrastructure as code", expectedIds: ["cli:terraform"] },
  { query: "upload files to AWS S3", expectedIds: ["cli:aws"] },
  { query: "sync files to a remote server over SSH", expectedIds: ["cli:rsync", "cli:ssh"] },
  { query: "send a message to a Slack channel", expectedIds: ["mcp:slack:tool:post_message"] },
  { query: "automate a headless browser and scrape DOM", expectedIds: ["cli:playwright", "mcp:playwright:tool:navigate"] },
  { query: "run a local open-weight LLM", expectedIds: ["cli:ollama"] },
  { query: "generate a TLS certificate with openssl", expectedIds: ["cli:openssl"] },
  { query: "inspect video codecs and duration", expectedIds: ["cli:ffprobe", "cli:ffmpeg"] },
  { query: "compress files into a ZIP archive", expectedIds: ["cli:zip"] },
  { query: "compile a Rust project with cargo", expectedIds: ["cli:cargo", "cli:rustc"] },
  { query: "commit changes to a git repository", expectedIds: ["cli:git"] },
  { query: "check if OpenAI API key is configured", expectedIds: ["provider:openai"] },
  { query: "read a local file from disk", expectedIds: ["mcp:filesystem:tool:read_file"] },
];

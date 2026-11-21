import type { RiskLevel } from "../schema";

export interface CuratedCliTool {
  name: string;
  versionArgs: string[];
  summary: string;
  risk: RiskLevel;
}

export const CURATED_CLI_MANIFEST: CuratedCliTool[] = [
  { name: "git", versionArgs: ["--version"], summary: "Distributed version control for commits, branches, diffs, and repos", risk: "writes-files" },
  { name: "gh", versionArgs: ["--version"], summary: "GitHub CLI to open PRs, manage issues, releases, and workflows", risk: "network" },
  { name: "ffmpeg", versionArgs: ["-version"], summary: "Convert, transcode, trim, and mux video and audio files (mp4, mp3, wav)", risk: "writes-files" },
  { name: "ffprobe", versionArgs: ["-version"], summary: "Inspect video and audio stream metadata, codecs, and duration", risk: "read-only" },
  { name: "blender", versionArgs: ["--version"], summary: "Render 3D .blend scenes, animations, and meshes headlessly to images/mp4", risk: "writes-files" },
  { name: "python3", versionArgs: ["--version"], summary: "Run Python 3 scripts for data processing, automation, and ML", risk: "writes-files" },
  { name: "python", versionArgs: ["--version"], summary: "Run Python scripts for automation, scripting, and data tasks", risk: "writes-files" },
  { name: "uv", versionArgs: ["--version"], summary: "Fast Python package, virtualenv, and script runner", risk: "network" },
  { name: "pip", versionArgs: ["--version"], summary: "Install and manage Python packages from PyPI", risk: "network" },
  { name: "pipx", versionArgs: ["--version"], summary: "Install and run Python CLI applications in isolated environments", risk: "network" },
  { name: "node", versionArgs: ["--version"], summary: "Execute JavaScript and TypeScript runtime scripts with Node.js", risk: "writes-files" },
  { name: "npm", versionArgs: ["--version"], summary: "Manage Node.js packages, scripts, and project dependencies", risk: "network" },
  { name: "pnpm", versionArgs: ["--version"], summary: "Fast disk-efficient Node.js package manager", risk: "network" },
  { name: "bun", versionArgs: ["--version"], summary: "Fast all-in-one JavaScript/TypeScript runtime, bundler, and test runner", risk: "writes-files" },
  { name: "deno", versionArgs: ["--version"], summary: "Secure TypeScript and JavaScript runtime with built-in tooling", risk: "writes-files" },
  { name: "docker", versionArgs: ["--version"], summary: "Build, run, and manage OCI containers and compose stacks", risk: "network" },
  { name: "kubectl", versionArgs: ["version", "--client"], summary: "Manage Kubernetes clusters, pods, deployments, and logs", risk: "network" },
  { name: "terraform", versionArgs: ["version"], summary: "Provision and manage cloud infrastructure as code", risk: "destructive" },
  { name: "aws", versionArgs: ["--version"], summary: "AWS CLI to manage S3, EC2, Lambda, IAM, and cloud services", risk: "network" },
  { name: "gcloud", versionArgs: ["--version"], summary: "Google Cloud CLI for Compute, Storage, BigQuery, and Cloud Run", risk: "network" },
  { name: "az", versionArgs: ["--version"], summary: "Azure CLI to manage Azure resources, VMs, and deployments", risk: "network" },
  { name: "magick", versionArgs: ["--version"], summary: "ImageMagick CLI to resize, crop, convert, and composite images", risk: "writes-files" },
  { name: "convert", versionArgs: ["--version"], summary: "ImageMagick image conversion, resizing, and format transformation", risk: "writes-files" },
  { name: "pandoc", versionArgs: ["--version"], summary: "Convert documents between docx, markdown, html, epub, and pdf", risk: "writes-files" },
  { name: "yt-dlp", versionArgs: ["--version"], summary: "Download videos, audio, and subtitles from YouTube and web sites", risk: "network" },
  { name: "whisper", versionArgs: ["--help"], summary: "Transcribe speech audio files (mp3, wav, m4a) to text locally", risk: "writes-files" },
  { name: "tesseract", versionArgs: ["--version"], summary: "OCR engine to extract text from images and scanned documents", risk: "read-only" },
  { name: "pdftotext", versionArgs: ["-v"], summary: "Extract plain text content from PDF documents", risk: "read-only" },
  { name: "qpdf", versionArgs: ["--version"], summary: "Split, merge, encrypt, and transform PDF files", risk: "writes-files" },
  { name: "gs", versionArgs: ["--version"], summary: "Ghostscript processor to compress, rasterize, and convert PDF/PS", risk: "writes-files" },
  { name: "soffice", versionArgs: ["--version"], summary: "LibreOffice headless converter for docx, xlsx, pptx, and pdf", risk: "writes-files" },
  { name: "curl", versionArgs: ["--version"], summary: "Transfer data and make HTTP/HTTPS API requests from the CLI", risk: "network" },
  { name: "wget", versionArgs: ["--version"], summary: "Download files and mirror web resources over HTTP/FTP", risk: "network" },
  { name: "http", versionArgs: ["--version"], summary: "HTTPie user-friendly CLI for testing REST APIs and JSON endpoints", risk: "network" },
  { name: "jq", versionArgs: ["--version"], summary: "Query, filter, slice, and transform JSON data streams", risk: "read-only" },
  { name: "yq", versionArgs: ["--version"], summary: "Query and edit YAML, JSON, and XML configuration files", risk: "writes-files" },
  { name: "rg", versionArgs: ["--version"], summary: "Ripgrep ultra-fast recursive regex search across code and text files", risk: "read-only" },
  { name: "fd", versionArgs: ["--version"], summary: "Fast user-friendly file and directory finder", risk: "read-only" },
  { name: "fzf", versionArgs: ["--version"], summary: "Interactive fuzzy finder for files, command history, and lists", risk: "read-only" },
  { name: "sqlite3", versionArgs: ["--version"], summary: "Query, inspect, and modify SQLite database files", risk: "writes-files" },
  { name: "psql", versionArgs: ["--version"], summary: "PostgreSQL interactive terminal for SQL queries and migrations", risk: "network" },
  { name: "duckdb", versionArgs: ["--version"], summary: "In-process analytical SQL engine for Parquet, CSV, and JSON", risk: "read-only" },
  { name: "redis-cli", versionArgs: ["--version"], summary: "Inspect and manage Redis keys, caches, and pub/sub channels", risk: "network" },
  { name: "ssh", versionArgs: ["-V"], summary: "Connect securely to remote servers and forward ports over SSH", risk: "network" },
  { name: "rsync", versionArgs: ["--version"], summary: "Synchronize and copy files efficiently between local and remote hosts", risk: "network" },
  { name: "tar", versionArgs: ["--version"], summary: "Create, list, and extract tar/gzip/xz archives", risk: "writes-files" },
  { name: "zip", versionArgs: ["-v"], summary: "Compress files and directories into ZIP archives", risk: "writes-files" },
  { name: "unzip", versionArgs: ["-v"], summary: "List and extract files from ZIP archives", risk: "writes-files" },
  { name: "cargo", versionArgs: ["--version"], summary: "Rust package manager, compiler frontend, and test runner", risk: "writes-files" },
  { name: "rustc", versionArgs: ["--version"], summary: "Compile Rust source code into native binaries", risk: "writes-files" },
  { name: "go", versionArgs: ["--version"], summary: "Build, test, and run Go programs and modules", risk: "writes-files" },
  { name: "gcc", versionArgs: ["--version"], summary: "GNU C and C++ compiler for native binaries", risk: "writes-files" },
  { name: "clang", versionArgs: ["--version"], summary: "LLVM C/C++/Objective-C compiler toolchain", risk: "writes-files" },
  { name: "make", versionArgs: ["--version"], summary: "Run Makefile build targets and automation recipes", risk: "writes-files" },
  { name: "cmake", versionArgs: ["--version"], summary: "Cross-platform build system generator for C/C++ projects", risk: "writes-files" },
  { name: "playwright", versionArgs: ["--version"], summary: "Automate Chromium, Firefox, and WebKit browsers for testing/scraping", risk: "network" },
  { name: "ollama", versionArgs: ["--version"], summary: "Run and manage local open-weight LLMs on-device", risk: "read-only" },
  { name: "openssl", versionArgs: ["version"], summary: "Generate TLS certificates, keys, hashes, and encrypt/decrypt data", risk: "writes-files" },
  { name: "brew", versionArgs: ["--version"], summary: "Homebrew package manager for macOS and Linux software", risk: "network" },
  { name: "tmux", versionArgs: ["-V"], summary: "Terminal multiplexer for persistent sessions, panes, and windows", risk: "read-only" },
];

export const CURATED_CLI_MAP = new Map<string, CuratedCliTool>(
  CURATED_CLI_MANIFEST.map((t) => [t.name, t])
);

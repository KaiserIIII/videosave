class Videosave < Formula
  desc "Local-first media downloader, browser companion, and native MCP server for AI agents"
  homepage "https://kaiseriiii.github.io/videosave/"
  url "https://github.com/KaiserIIII/videosave/releases/download/v1.3.0/VideoSave-1.3.0-unix.tar.gz"
  sha256 "fd961b17283d26ea052c914b0d299c0bbb9cdb8893749043ec08a093a21bd0c4"
  license "MIT"

  depends_on "node@24"
  depends_on "ffmpeg"

  def install
    libexec.install Dir["*"]
    (bin/"videosave").write_env_script libexec/"tools/start-unix.sh", PATH: "#{Formula["node@24"].opt_bin}:#{Formula["ffmpeg"].opt_bin}:$PATH"
    (bin/"videosave-cli").write_env_script libexec/"tools/media-cli.mjs", PATH: "#{Formula["node@24"].opt_bin}:#{Formula["ffmpeg"].opt_bin}:$PATH"
    (bin/"videosave-mcp").write_env_script libexec/"tools/mcp-server.mjs", PATH: "#{Formula["node@24"].opt_bin}:#{Formula["ffmpeg"].opt_bin}:$PATH"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/videosave-cli --help")
  end
end

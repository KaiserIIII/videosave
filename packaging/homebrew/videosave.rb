class Videosave < Formula
  desc "Local-first media downloader, browser companion, and native MCP server for AI agents"
  homepage "https://kaiseriiii.github.io/videosave/"
  url "https://github.com/KaiserIIII/videosave/releases/download/v1.3.1/VideoSave-1.3.1-unix.tar.gz"
  sha256 "7568b24814b50ad5006dac8fcb8719b304b96d2a33da917c11611cd8dc665645"
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

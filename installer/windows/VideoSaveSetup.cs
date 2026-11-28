using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace VideoSaveSetup
{
    internal static class Program
    {
        private const string Version = "1.2.0";
        private const string PayloadResource = "VideoSavePayload.zip";

        [STAThread]
        private static int Main(string[] args)
        {
            var opts = SetupOptions.Parse(args);
            if (opts.Silent)
            {
                try
                {
                    InstallerEngine.Install(opts, msg => Console.WriteLine("[VideoSave Setup] " + msg), null);
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("VideoSave Setup failed: " + ex.Message);
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(opts));
            return 0;
        }

        internal sealed class SetupOptions
        {
            public string InstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VideoSave", "app");
            public bool Silent;
            public bool SkipComponents;
            public bool SkipShortcuts;
            public bool SkipRegistry;
            public bool DesktopShortcut;
            public bool AutoStart;
            public bool LaunchAfter = true;

            public static SetupOptions Parse(string[] args)
            {
                var opts = new SetupOptions();
                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i] ?? "";
                    if (a.Equals("/S", StringComparison.OrdinalIgnoreCase) || a.Equals("--silent", StringComparison.OrdinalIgnoreCase))
                        opts.Silent = true;
                    else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase))
                        opts.InstallDir = a.Substring(3).Trim('"');
                    else if (a.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase))
                        opts.InstallDir = a.Substring(6).Trim('"');
                    else if (a.Equals("/SkipComponents", StringComparison.OrdinalIgnoreCase))
                        opts.SkipComponents = true;
                    else if (a.Equals("/SkipShortcuts", StringComparison.OrdinalIgnoreCase))
                        opts.SkipShortcuts = true;
                    else if (a.Equals("/SkipRegistry", StringComparison.OrdinalIgnoreCase))
                        opts.SkipRegistry = true;
                    else if (a.Equals("/DesktopShortcut", StringComparison.OrdinalIgnoreCase))
                        opts.DesktopShortcut = true;
                    else if (a.Equals("/AutoStart", StringComparison.OrdinalIgnoreCase))
                        opts.AutoStart = true;
                    else if (a.Equals("/NoLaunch", StringComparison.OrdinalIgnoreCase))
                        opts.LaunchAfter = false;
                }
                return opts;
            }
        }

        internal static class InstallerEngine
        {
            public static void Install(SetupOptions opts, Action<string> log, Action<int> progress)
            {
                string targetDir = Path.GetFullPath(opts.InstallDir);
                string parentDir = Path.GetDirectoryName(targetDir);
                if (string.IsNullOrEmpty(parentDir))
                    throw new InvalidOperationException("InstallDir cannot be a filesystem root.");

                string guid = Guid.NewGuid().ToString("N").Substring(0, 8);
                string stagingDir = targetDir + ".staging-" + guid;
                string backupDir = targetDir + ".rollback-" + guid;
                bool hadPrior = Directory.Exists(targetDir);

                Directory.CreateDirectory(parentDir);
                Directory.CreateDirectory(stagingDir);

                try
                {
                    if (progress != null) progress(15);
                    log("Extracting VideoSave " + Version + " package...");
                    ExtractEmbeddedPayload(stagingDir);

                    if (progress != null) progress(45);
                    string metaJson = "{\n  \"version\": \"" + Version + "\",\n  \"installedAt\": \"" +
                        DateTime.UtcNow.ToString("o") + "\",\n  \"installDir\": \"" +
                        targetDir.Replace("\\", "\\\\") + "\",\n  \"installer\": \"VideoSaveSetup.exe\"\n}\n";
                    File.WriteAllText(Path.Combine(stagingDir, "videosave-install.json"), metaJson, Encoding.UTF8);

                    if (hadPrior)
                        Directory.Move(targetDir, backupDir);
                    Directory.Move(stagingDir, targetDir);

                    if (progress != null) progress(60);
                    if (!opts.SkipComponents)
                    {
                        log("Verifying pinned runtime components (Node.js 24, FFmpeg 8.1.2, yt-dlp)...");
                        string startPs1 = Path.Combine(targetDir, "tools", "start-windows.ps1");
                        if (File.Exists(startPs1))
                        {
                            var psi = new ProcessStartInfo("powershell.exe",
                                "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + startPs1 + "\" -SetupOnly")
                            {
                                WorkingDirectory = targetDir,
                                UseShellExecute = false,
                                CreateNoWindow = true,
                                RedirectStandardError = true,
                                RedirectStandardOutput = true
                            };
                            using (var proc = Process.Start(psi))
                            {
                                string stdOut = proc.StandardOutput.ReadToEnd();
                                string stdErr = proc.StandardError.ReadToEnd();
                                proc.WaitForExit(300000);
                                if (proc.ExitCode != 0)
                                    throw new InvalidOperationException("Runtime preparation failed: " + (stdErr.Length > 0 ? stdErr : stdOut));
                            }
                        }
                    }

                    if (progress != null) progress(82);
                    if (!opts.SkipShortcuts)
                    {
                        log("Creating Start Menu shortcuts (no system PATH changes)...");
                        string startMenu = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.Programs), "VideoSave");
                        Directory.CreateDirectory(startMenu);
                        CreateShortcut(
                            Path.Combine(startMenu, "VideoSave.lnk"),
                            Path.Combine(targetDir, "Start VideoSave.cmd"),
                            targetDir,
                            "Launch VideoSave Companion and Local Management Center");
                        CreateShortcut(
                            Path.Combine(startMenu, "Uninstall VideoSave.lnk"),
                            Path.Combine(targetDir, "Uninstall VideoSave.cmd"),
                            targetDir,
                            "Uninstall VideoSave (preserves your downloaded videos)");

                        if (opts.DesktopShortcut)
                        {
                            CreateShortcut(
                                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "VideoSave.lnk"),
                                Path.Combine(targetDir, "Start VideoSave.cmd"),
                                targetDir,
                                "Start VideoSave");
                        }
                    }

                    if (progress != null) progress(92);
                    if (!opts.SkipRegistry)
                    {
                        log("Registering per-user uninstaller (HKCU, zero admin required)...");
                        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\VideoSave"))
                        {
                            key.SetValue("DisplayName", "VideoSave");
                            key.SetValue("DisplayVersion", Version);
                            key.SetValue("Publisher", "VideoSave Contributors");
                            key.SetValue("InstallLocation", targetDir);
                            key.SetValue("UninstallString", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" +
                                Path.Combine(targetDir, "tools", "uninstall-windows.ps1") + "\"");
                            key.SetValue("URLInfoAbout", "https://kaiseriiii.github.io/videosave/");
                            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                        }
                        if (opts.AutoStart)
                        {
                            using (var runKey = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                            {
                                runKey.SetValue("VideoSave", "\"" + Path.Combine(targetDir, "Start VideoSave.cmd") + "\"");
                            }
                        }
                    }

                    if (Directory.Exists(backupDir))
                    {
                        try { Directory.Delete(backupDir, true); } catch { }
                    }

                    if (progress != null) progress(100);
                    log("Installation complete! Ready at: " + targetDir);
                }
                catch
                {
                    try { if (Directory.Exists(stagingDir)) Directory.Delete(stagingDir, true); } catch { }
                    if (hadPrior && Directory.Exists(backupDir))
                    {
                        try
                        {
                            if (Directory.Exists(targetDir)) Directory.Delete(targetDir, true);
                            Directory.Move(backupDir, targetDir);
                        }
                        catch { }
                    }
                    throw;
                }
            }

            private static void ExtractEmbeddedPayload(string destinationDir)
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var stream = asm.GetManifestResourceStream(PayloadResource))
                {
                    if (stream == null)
                        throw new InvalidOperationException("Embedded VideoSave payload is missing.");
                    using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
                    {
                        string prefix = "VideoSave-" + Version + "/";
                        string destFull = Path.GetFullPath(destinationDir) + Path.DirectorySeparatorChar;
                        foreach (var entry in archive.Entries)
                        {
                            if (string.IsNullOrEmpty(entry.Name)) continue;
                            string rel = entry.FullName.Replace('\\', '/');
                            if (rel.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                                rel = rel.Substring(prefix.Length);
                            if (rel.Contains("..")) continue;
                            string targetPath = Path.GetFullPath(Path.Combine(destinationDir, rel.Replace('/', Path.DirectorySeparatorChar)));
                            if (!targetPath.StartsWith(destFull, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidOperationException("Unsafe path inside archive: " + rel);
                            Directory.CreateDirectory(Path.GetDirectoryName(targetPath));
                            entry.ExtractToFile(targetPath, true);
                        }
                    }
                }
            }

            private static void CreateShortcut(string shortcutPath, string targetPath, string workingDir, string description)
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                dynamic shell = Activator.CreateInstance(shellType);
                try
                {
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = targetPath;
                    shortcut.WorkingDirectory = workingDir;
                    shortcut.Description = description;
                    shortcut.Save();
                    Marshal.FinalReleaseComObject(shortcut);
                }
                finally
                {
                    Marshal.FinalReleaseComObject(shell);
                }
            }
        }

        private sealed class SetupForm : Form
        {
            private readonly SetupOptions _opts;
            private readonly TextBox _dirBox;
            private readonly CheckBox _desktopChk;
            private readonly CheckBox _autoStartChk;
            private readonly CheckBox _launchChk;
            private readonly ProgressBar _bar;
            private readonly TextBox _logBox;
            private readonly Button _installBtn;
            private readonly Button _browseBtn;

            public SetupForm(SetupOptions opts)
            {
                _opts = opts;
                Text = "VideoSave " + Version + " Setup";
                Size = new Size(560, 440);
                FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false;
                StartPosition = FormStartPosition.CenterScreen;
                BackColor = Color.FromArgb(18, 22, 31);
                ForeColor = Color.FromArgb(236, 241, 248);
                Font = new Font("Segoe UI", 9.5f);

                var title = new Label
                {
                    Text = "VideoSave v" + Version + " — 安装向导 / Setup",
                    Font = new Font("Segoe UI Semibold", 13f),
                    Location = new Point(22, 18),
                    AutoSize = true
                };
                var subtitle = new Label
                {
                    Text = "本地优先媒体下载引擎 · 管理中心 (/console) · 原生 MCP 服务（无需管理员权限，不污染系统 PATH）",
                    ForeColor = Color.FromArgb(164, 177, 198),
                    Location = new Point(22, 48),
                    Size = new Size(505, 34)
                };

                var dirLbl = new Label { Text = "安装目录 / Install Folder:", Location = new Point(22, 92), AutoSize = true };
                _dirBox = new TextBox
                {
                    Text = opts.InstallDir,
                    Location = new Point(22, 114),
                    Size = new Size(418, 26),
                    BackColor = Color.FromArgb(28, 34, 47),
                    ForeColor = Color.White,
                    BorderStyle = BorderStyle.FixedSingle
                };
                _browseBtn = new Button
                {
                    Text = "浏览...",
                    Location = new Point(448, 113),
                    Size = new Size(76, 26),
                    FlatStyle = FlatStyle.Flat,
                    BackColor = Color.FromArgb(37, 46, 63)
                };
                _browseBtn.Click += (s, e) =>
                {
                    using (var dlg = new FolderBrowserDialog { SelectedPath = _dirBox.Text })
                    {
                        if (dlg.ShowDialog() == DialogResult.OK) _dirBox.Text = dlg.SelectedPath;
                    }
                };

                _desktopChk = new CheckBox { Text = "创建桌面快捷方式 / Create Desktop shortcut", Location = new Point(24, 152), AutoSize = true, Checked = opts.DesktopShortcut };
                _autoStartChk = new CheckBox { Text = "开机自动启动 / Start at Windows sign-in", Location = new Point(24, 178), AutoSize = true, Checked = opts.AutoStart };
                _launchChk = new CheckBox { Text = "安装后启动本机管理中心 (http://127.0.0.1:8765/console)", Location = new Point(24, 204), AutoSize = true, Checked = opts.LaunchAfter };

                _bar = new ProgressBar { Location = new Point(22, 238), Size = new Size(502, 18), Style = ProgressBarStyle.Continuous };
                _logBox = new TextBox
                {
                    Location = new Point(22, 266),
                    Size = new Size(502, 84),
                    Multiline = true,
                    ReadOnly = true,
                    ScrollBars = ScrollBars.Vertical,
                    BackColor = Color.FromArgb(12, 15, 22),
                    ForeColor = Color.FromArgb(170, 225, 195),
                    BorderStyle = BorderStyle.FixedSingle,
                    Text = "准备就绪。安装过程自动准备受校验的 Node.js / FFmpeg / yt-dlp，卸载时绝不删除您的下载视频。"
                };

                _installBtn = new Button
                {
                    Text = "开始安装 / Install",
                    Location = new Point(374, 360),
                    Size = new Size(150, 32),
                    FlatStyle = FlatStyle.Flat,
                    BackColor = Color.FromArgb(16, 163, 127),
                    ForeColor = Color.White,
                    Font = new Font("Segoe UI Semibold", 9.5f)
                };
                _installBtn.Click += async (s, e) => await RunInstallAsync();

                Controls.AddRange(new Control[] { title, subtitle, dirLbl, _dirBox, _browseBtn, _desktopChk, _autoStartChk, _launchChk, _bar, _logBox, _installBtn });
            }

            private async Task RunInstallAsync()
            {
                _installBtn.Enabled = false;
                _browseBtn.Enabled = false;
                _dirBox.Enabled = false;
                _opts.InstallDir = _dirBox.Text.Trim();
                _opts.DesktopShortcut = _desktopChk.Checked;
                _opts.AutoStart = _autoStartChk.Checked;
                _opts.LaunchAfter = _launchChk.Checked;

                try
                {
                    await Task.Run(() => InstallerEngine.Install(
                        _opts,
                        msg => BeginInvoke((Action)(() => _logBox.AppendText(Environment.NewLine + msg))),
                        pct => BeginInvoke((Action)(() => _bar.Value = Math.Max(0, Math.Min(100, pct))))
                    ));
                    if (_opts.LaunchAfter)
                    {
                        string cmd = Path.Combine(_opts.InstallDir, "Start VideoSave.cmd");
                        if (File.Exists(cmd))
                            Process.Start(new ProcessStartInfo(cmd) { WorkingDirectory = _opts.InstallDir, UseShellExecute = true });
                    }
                    MessageBox.Show(
                        "VideoSave v" + Version + " 安装完成！\n\n" +
                        "• 管理中心: http://127.0.0.1:8765/console\n" +
                        "• 浏览器扩展: 解压目录下的 extension/ 文件夹，或安装官方商店扩展\n" +
                        "• AI / MCP 配置: 在管理中心「MCP 与 AI」页一键复制 6 大客户端配置",
                        "VideoSave Setup",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    Close();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("安装失败并已自动回滚：\n" + ex.Message, "VideoSave Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    _installBtn.Enabled = true;
                    _browseBtn.Enabled = true;
                    _dirBox.Enabled = true;
                }
            }
        }
    }
}

package io.github.kaiseriiii.videosave;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/**
 * VideoSave Native Android App (v1.2.0)
 * - Standalone APK (zero Root, zero Termux, zero Python)
 * - Receives links via Android Share Menu (ACTION_SEND) & paste
 * - Bilingual EN / 中文, Dark / Light theme, quality probe, resumable HLS/HTTP foreground service,
 *   Scoped Storage Downloads/VideoSave integration, download history & native player preview.
 */
public final class MainActivity extends Activity {

    private static final String PREFS = "videosave_prefs";
    private boolean isZh = true;
    private boolean isDark = true;

    private LinearLayout rootLayout;
    private TextView headerTitle;
    private TextView headerSub;
    private EditText urlInput;
    private EditText folderInput;
    private EditText refererInput;
    private Button probeBtn;
    private Button batchBtn;
    private Button cancelBtn;
    private Button langBtn;
    private Button themeBtn;
    private TextView statusLabel;
    private ProgressBar progressBar;
    private LinearLayout candidatesContainer;
    private LinearLayout historyContainer;
    private TextView harmonyNote;

    private List<MediaProbeEngine.QualityCandidate> currentCandidates = new ArrayList<MediaProbeEngine.QualityCandidate>();
    private String currentTitle = "videosave_media";

    private final BroadcastReceiver progressReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String status = intent.getStringExtra("status");
            String msg = intent.getStringExtra("message");
            int pct = intent.getIntExtra("percent", 0);
            progressBar.setProgress(pct);
            statusLabel.setText(msg != null ? msg : status);
            if ("done".equals(status) || "error".equals(status)) {
                renderHistory();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        isZh = sp.getBoolean("zh", true);
        isDark = sp.getBoolean("dark", true);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
        }

        buildUi();
        applyThemeAndLanguage();
        handleIncomingIntent(getIntent());
        renderHistory();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        IntentFilter f = new IntentFilter(DownloadService.ACTION_PROGRESS);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(progressReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(progressReceiver, f);
        }
        renderHistory();
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { unregisterReceiver(progressReceiver); } catch (Exception ignored) {}
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String shared = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            shared = intent.getData().toString();
        }
        if (shared != null && !shared.trim().isEmpty()) {
            // Extract first http(s) URL if share text contains title + link
            String extracted = shared.trim();
            int httpIdx = extracted.indexOf("http");
            if (httpIdx >= 0) {
                String tail = extracted.substring(httpIdx);
                int spaceIdx = tail.indexOf(' ');
                extracted = spaceIdx > 0 ? tail.substring(0, spaceIdx) : tail;
            }
            urlInput.setText(extracted);
            runProbe();
        }
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        rootLayout = new LinearLayout(this);
        rootLayout.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        rootLayout.setPadding(pad, dp(40), pad, dp(32));

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);

        LinearLayout titleCol = new LinearLayout(this);
        titleCol.setOrientation(LinearLayout.VERTICAL);
        titleCol.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        headerTitle = new TextView(this);
        headerTitle.setTextSize(22f);
        headerTitle.setTypeface(Typeface.DEFAULT_BOLD);
        headerSub = new TextView(this);
        headerSub.setTextSize(12f);
        titleCol.addView(headerTitle);
        titleCol.addView(headerSub);

        langBtn = makeCompactButton("EN");
        langBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isZh = !isZh;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("zh", isZh).apply();
                applyThemeAndLanguage();
            }
        });
        themeBtn = makeCompactButton("☀");
        themeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isDark = !isDark;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("dark", isDark).apply();
                applyThemeAndLanguage();
            }
        });

        topBar.addView(titleCol);
        topBar.addView(langBtn);
        topBar.addView(themeBtn);
        rootLayout.addView(topBar);

        urlInput = new EditText(this);
        urlInput.setMinLines(2);
        urlInput.setMaxLines(4);
        urlInput.setTextSize(14f);
        rootLayout.addView(urlInput, marginTop(14));

        LinearLayout optRow = new LinearLayout(this);
        optRow.setOrientation(LinearLayout.HORIZONTAL);
        folderInput = new EditText(this);
        folderInput.setText("VideoSave");
        folderInput.setTextSize(13f);
        refererInput = new EditText(this);
        refererInput.setTextSize(13f);
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        half.setMargins(0, 0, dp(8), 0);
        optRow.addView(folderInput, half);
        optRow.addView(refererInput, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        rootLayout.addView(optRow, marginTop(8));

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        probeBtn = makeActionButton("#10B981");
        probeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { runProbe(); }
        });
        batchBtn = makeActionButton("#2563EB");
        batchBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { enqueueBatchFromInput(); }
        });
        cancelBtn = makeActionButton("#DC2626");
        cancelBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, DownloadService.class);
                i.setAction(DownloadService.ACTION_CANCEL);
                startService(i);
            }
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(0, dp(44), 1f);
        bp.setMargins(0, 0, dp(6), 0);
        btnRow.addView(probeBtn, bp);
        btnRow.addView(batchBtn, bp);
        btnRow.addView(cancelBtn, new LinearLayout.LayoutParams(0, dp(44), 0.7f));
        rootLayout.addView(btnRow, marginTop(12));

        statusLabel = new TextView(this);
        statusLabel.setTextSize(13f);
        rootLayout.addView(statusLabel, marginTop(14));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        rootLayout.addView(progressBar, marginTop(6));

        candidatesContainer = new LinearLayout(this);
        candidatesContainer.setOrientation(LinearLayout.VERTICAL);
        rootLayout.addView(candidatesContainer, marginTop(12));

        historyContainer = new LinearLayout(this);
        historyContainer.setOrientation(LinearLayout.VERTICAL);
        rootLayout.addView(historyContainer, marginTop(16));

        harmonyNote = new TextView(this);
        harmonyNote.setTextSize(11.5f);
        harmonyNote.setPadding(dp(10), dp(10), dp(10), dp(10));
        rootLayout.addView(harmonyNote, marginTop(18));

        scroll.addView(rootLayout);
        setContentView(scroll);
    }

    private void runProbe() {
        final String raw = urlInput.getText().toString().trim();
        final String firstLine = raw.split("\\r?\\n")[0].trim();
        final String ref = refererInput.getText().toString().trim();
        if (firstLine.isEmpty()) {
            Toast.makeText(this, isZh ? "请先粘贴媒体链接" : "Paste a media URL first", Toast.LENGTH_SHORT).show();
            return;
        }
        statusLabel.setText(isZh ? "正在探测可用画质与权限..." : "Probing available qualities...");
        candidatesContainer.removeAllViews();

        new Thread(new Runnable() {
            @Override
            public void run() {
                final MediaProbeEngine.ProbeResult res = MediaProbeEngine.probe(firstLine, null, ref);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        currentTitle = res.title;
                        currentCandidates = res.candidates;
                        statusLabel.setText("[" + res.status.toUpperCase() + "] " + res.message);
                        renderCandidates();
                    }
                });
            }
        }).start();
    }

    private void renderCandidates() {
        candidatesContainer.removeAllViews();
        if (currentCandidates.isEmpty()) return;
        for (final MediaProbeEngine.QualityCandidate c : currentCandidates) {
            Button b = makeActionButton("available".equals(c.availability) ? "#059669"
                    : "restricted".equals(c.availability) ? "#B45309" : "#475569");
            b.setText((isZh ? "下载 · " : "Download · ") + c.label);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if ("restricted".equals(c.availability)) {
                        Toast.makeText(MainActivity.this,
                                isZh ? "该画质返回访问拒绝，VideoSave 不会绕过权限限制" : "Access restricted (not bypassed)",
                                Toast.LENGTH_LONG).show();
                        return;
                    }
                    startDownloadTask(c.url, currentTitle, c.kind);
                }
            });
            candidatesContainer.addView(b, marginTop(6));
        }
    }

    private void enqueueBatchFromInput() {
        String raw = urlInput.getText().toString().trim();
        if (raw.isEmpty()) return;
        String[] lines = raw.split("\\r?\\n");
        int count = 0;
        for (String line : lines) {
            String u = line.trim();
            if (u.startsWith("http://") || u.startsWith("https://")) {
                String kind = u.toLowerCase().contains(".m3u8") ? "hls" : "mp4";
                startDownloadTask(u, MediaProbeEngine.inferTitle(u), kind);
                count++;
            }
        }
        statusLabel.setText(isZh ? ("已加入队列: " + count + " 个任务") : ("Queued " + count + " task(s)"));
    }

    private void startDownloadTask(String url, String title, String kind) {
        Intent i = new Intent(this, DownloadService.class);
        i.setAction(DownloadService.ACTION_ENQUEUE);
        i.putExtra("url", url);
        i.putExtra("title", title);
        i.putExtra("kind", kind);
        i.putExtra("referer", refererInput.getText().toString().trim());
        i.putExtra("folder", folderInput.getText().toString().trim());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i);
        } else {
            startService(i);
        }
    }

    private void renderHistory() {
        historyContainer.removeAllViews();
        TextView title = new TextView(this);
        title.setText(isZh ? "下载历史（点击预览播放）" : "Download History (tap to preview)");
        title.setTextSize(15f);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(isDark ? Color.WHITE : Color.parseColor("#0F172A"));
        historyContainer.addView(title);

        List<DownloadHistoryStore.Record> records = DownloadHistoryStore.load(this);
        if (records.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(isZh ? "暂无下载记录，支持系统分享菜单直接发送到 VideoSave。" : "No downloads yet. Use Android Share menu or paste a link above.");
            empty.setTextColor(Color.parseColor("#94A3B8"));
            historyContainer.addView(empty, marginTop(6));
            return;
        }
        int shown = Math.min(records.size(), 15);
        for (int idx = 0; idx < shown; idx++) {
            final DownloadHistoryStore.Record r = records.get(idx);
            TextView row = new TextView(this);
            row.setPadding(dp(10), dp(10), dp(10), dp(10));
            row.setBackgroundColor(isDark ? Color.parseColor("#1E293B") : Color.parseColor("#E2E8F0"));
            row.setTextColor(isDark ? Color.parseColor("#E2E8F0") : Color.parseColor("#0F172A"));
            row.setText(("done".equals(r.status) ? "✓ " : "✗ ") + r.title + "\n" + r.displayPath +
                    (r.bytes > 0 ? " · " + MediaProbeEngine.formatSize(r.bytes) : ""));
            if ("done".equals(r.status) && r.contentUri != null && !r.contentUri.isEmpty()) {
                row.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        try {
                            Intent view = new Intent(Intent.ACTION_VIEW);
                            view.setDataAndType(Uri.parse(r.contentUri), r.title.endsWith(".m4a") ? "audio/*" : "video/*");
                            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(view);
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "Saved at: " + r.displayPath, Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
            historyContainer.addView(row, marginTop(6));
        }
    }

    private void applyThemeAndLanguage() {
        int bg = isDark ? Color.parseColor("#0B1120") : Color.parseColor("#F8FAFC");
        int fg = isDark ? Color.parseColor("#F1F5F9") : Color.parseColor("#0F172A");
        int muted = isDark ? Color.parseColor("#94A3B8") : Color.parseColor("#475569");
        int fieldBg = isDark ? Color.parseColor("#1E293B") : Color.WHITE;

        rootLayout.setBackgroundColor(bg);
        headerTitle.setTextColor(fg);
        headerSub.setTextColor(muted);
        statusLabel.setTextColor(fg);
        urlInput.setBackgroundColor(fieldBg);
        urlInput.setTextColor(fg);
        urlInput.setHintTextColor(muted);
        folderInput.setBackgroundColor(fieldBg);
        folderInput.setTextColor(fg);
        refererInput.setBackgroundColor(fieldBg);
        refererInput.setTextColor(fg);
        refererInput.setHintTextColor(muted);
        harmonyNote.setBackgroundColor(isDark ? Color.parseColor("#172554") : Color.parseColor("#DBEAFE"));
        harmonyNote.setTextColor(isDark ? Color.parseColor("#BFDBFE") : Color.parseColor("#1E3A8A"));

        headerTitle.setText("VideoSave v1.2.0");
        headerSub.setText(isZh ? "本地优先 · 断点续传 · 无需 Root/Termux" : "Local-first · Resumable HLS/HTTP · No Root/Termux");
        urlInput.setHint(isZh ? "粘贴视频直链 / .m3u8 / .mpd / 网页链接（支持多行批量）" : "Paste media / .m3u8 / .mpd / page URLs (one per line)");
        refererInput.setHint(isZh ? "可选 Referer 请求头" : "Optional Referer header");
        probeBtn.setText(isZh ? "探测画质" : "Probe");
        batchBtn.setText(isZh ? "直接/批量下载" : "Download");
        cancelBtn.setText(isZh ? "取消" : "Cancel");
        langBtn.setText(isZh ? "EN" : "中文");
        themeBtn.setText(isDark ? "☀" : "☾");
        if (statusLabel.getText().length() == 0) {
            statusLabel.setText(isZh ? "就绪：支持系统分享菜单接收链接，保存到 Downloads/VideoSave" : "Ready: Share links here from any browser. Saves to Downloads/VideoSave.");
        }
        harmonyNote.setText(isZh
                ? "华为 Mate 60 Pro / HarmonyOS 说明：HarmonyOS 4.x（含 Android 兼容层）可直接安装本 APK；HarmonyOS NEXT 纯血版不支持原生 APK，需使用桌面版管理中心或关注 ArkTS 原生版路线图。绝不绕过 DRM 或付费访问限制。"
                : "Huawei Mate 60 Pro / HarmonyOS note: HarmonyOS 4.x supports this APK directly; HarmonyOS NEXT does not install native APKs (see ArkTS roadmap in docs). VideoSave never bypasses DRM or paywalls.");
        renderHistory();
    }

    private Button makeActionButton(String hexColor) {
        Button b = new Button(this);
        b.setBackgroundColor(Color.parseColor(hexColor));
        b.setTextColor(Color.WHITE);
        b.setAllCaps(false);
        b.setTextSize(13f);
        return b;
    }

    private Button makeCompactButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(12f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(48), dp(36));
        lp.setMargins(dp(6), 0, 0, 0);
        b.setLayoutParams(lp);
        return b;
    }

    private LinearLayout.LayoutParams marginTop(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        return lp;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

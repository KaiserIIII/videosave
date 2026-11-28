package io.github.kaiseriiii.videosave;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.ContentValues;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.StatFs;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/**
 * VideoSave Modern Native Android App (v1.3.0):
 * - 4-tab product layout: Home/Probe, Active Queue, History, Settings & Status
 * - Rounded card design system, Bilingual EN/中文, Dark/Light themes, Accessibility labels
 * - One-tap clipboard paste & Android Share Menu intake
 * - Native Bilibili (BV / bilibili.com / b23.tv), Static DASH (MediaMuxer), Resumable HLS & Strict HTTP Range
 */
public final class MainActivity extends Activity {

    private static final String PREFS = "videosave_prefs";
    private boolean isZh = true;
    private boolean isDark = true;
    private boolean wifiOnly = false;
    private int activeTab = 0; // 0=Home, 1=Queue, 2=History, 3=Settings

    private LinearLayout rootShell;
    private LinearLayout contentContainer;
    private LinearLayout navBar;
    private TextView headerTitle;
    private TextView headerSub;
    private Button langBtn;
    private Button themeBtn;

    private EditText urlInput;
    private TextView probeStatusView;
    private LinearLayout previewCard;
    private LinearLayout candidatesContainer;
    private ProgressBar liveProgressBar;
    private TextView liveProgressText;

    private EditText folderInput;
    private EditText refererInput;
    private CheckBox wifiOnlyBox;

    private List<MediaProbeEngine.QualityCandidate> currentCandidates = new ArrayList<MediaProbeEngine.QualityCandidate>();
    private String currentTitle = "";
    private String currentProbeSummary = "";

    private final BroadcastReceiver progressReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String status = intent.getStringExtra("status");
            String msg = intent.getStringExtra("message");
            int pct = intent.getIntExtra("percent", 0);
            if (liveProgressBar != null) liveProgressBar.setProgress(pct);
            if (liveProgressText != null) liveProgressText.setText(msg != null ? msg : status);
            if (activeTab == 1 || activeTab == 2 || "done".equals(status) || "error".equals(status)) {
                renderActiveTab();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        isZh = sp.getBoolean("zh", true);
        isDark = sp.getBoolean("dark", true);
        wifiOnly = sp.getBoolean("wifi_only", false);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
        }

        buildShell();
        renderActiveTab();
        handleIncomingIntent(getIntent());
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
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(progressReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(progressReceiver, f);
        renderActiveTab();
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
            String extracted = extractLinkFromShareText(shared);
            activeTab = 0;
            renderActiveTab();
            if (urlInput != null) {
                urlInput.setText(extracted);
                runProbe();
            }
        }
    }

    private static String extractLinkFromShareText(String raw) {
        String s = raw.trim();
        int httpIdx = s.indexOf("http");
        if (httpIdx >= 0) {
            String tail = s.substring(httpIdx);
            int end = tail.length();
            for (int i = 0; i < tail.length(); i++) {
                char c = tail.charAt(i);
                if (Character.isWhitespace(c) || c == '"' || c == '\'' || c == '>' || c == '】') {
                    end = i;
                    break;
                }
            }
            return tail.substring(0, end);
        }
        return s;
    }

    private void buildShell() {
        rootShell = new LinearLayout(this);
        rootShell.setOrientation(LinearLayout.VERTICAL);

        // Top App Bar
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setPadding(dp(18), dp(36), dp(18), dp(12));

        LinearLayout brandCol = new LinearLayout(this);
        brandCol.setOrientation(LinearLayout.VERTICAL);
        brandCol.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        headerTitle = new TextView(this);
        headerTitle.setTextSize(21f);
        headerTitle.setTypeface(Typeface.DEFAULT_BOLD);
        headerSub = new TextView(this);
        headerSub.setTextSize(12f);
        brandCol.addView(headerTitle);
        brandCol.addView(headerSub);

        langBtn = makePillButton("EN");
        langBtn.setContentDescription("Switch language");
        langBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isZh = !isZh;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("zh", isZh).apply();
                refreshShellTheme();
                renderActiveTab();
            }
        });
        themeBtn = makePillButton("☀");
        themeBtn.setContentDescription("Toggle dark or light theme");
        themeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                isDark = !isDark;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("dark", isDark).apply();
                refreshShellTheme();
                renderActiveTab();
            }
        });

        topBar.addView(brandCol);
        topBar.addView(langBtn);
        topBar.addView(themeBtn);
        rootShell.addView(topBar);

        // Scrollable Body
        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        contentContainer = new LinearLayout(this);
        contentContainer.setOrientation(LinearLayout.VERTICAL);
        contentContainer.setPadding(dp(16), dp(4), dp(16), dp(24));
        scroll.addView(contentContainer);
        rootShell.addView(scroll);

        // Bottom Navigation Bar (4 modern tabs)
        navBar = new LinearLayout(this);
        navBar.setOrientation(LinearLayout.HORIZONTAL);
        navBar.setPadding(dp(8), dp(8), dp(8), dp(12));
        rootShell.addView(navBar);

        setContentView(rootShell);
        refreshShellTheme();
    }

    private void refreshShellTheme() {
        rootShell.setBackgroundColor(cBg());
        headerTitle.setTextColor(cText());
        headerSub.setTextColor(cMuted());
        headerTitle.setText("VideoSave");
        String appVer = getInstalledVersionName();
        headerSub.setText(isZh
                ? "v" + appVer + " · 本地优先 · Bilibili / DASH / HLS / HTTP"
                : "v" + appVer + " · Local-first · Bilibili / DASH / HLS / HTTP");
        langBtn.setText(isZh ? "EN" : "中文");
        themeBtn.setText(isDark ? "☀" : "☾");
        stylePillButton(langBtn, false);
        stylePillButton(themeBtn, false);
        renderNavBar();
    }

    private void renderNavBar() {
        navBar.removeAllViews();
        navBar.setBackgroundColor(cSurface());
        String[] labels = isZh
                ? new String[]{"首页探测", "任务队列", "下载历史", "设置与状态"}
                : new String[]{"Home", "Queue", "History", "Settings"};
        for (int i = 0; i < labels.length; i++) {
            final int tabIdx = i;
            Button b = new Button(this);
            b.setText(labels[i]);
            b.setAllCaps(false);
            b.setTextSize(12.5f);
            b.setContentDescription(labels[i]);
            boolean active = (activeTab == tabIdx);
            b.setTextColor(active ? Color.WHITE : cMuted());
            b.setTypeface(active ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            b.setBackground(roundedBox(active ? Color.parseColor("#2563EB") : Color.TRANSPARENT, 12, 0, Color.TRANSPARENT));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(40), 1f);
            lp.setMargins(dp(4), 0, dp(4), 0);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    activeTab = tabIdx;
                    renderNavBar();
                    renderActiveTab();
                }
            });
            navBar.addView(b, lp);
        }
    }

    private void renderActiveTab() {
        renderNavBar();
        contentContainer.removeAllViews();
        if (activeTab == 0) renderHomeTab();
        else if (activeTab == 1) renderQueueTab();
        else if (activeTab == 2) renderHistoryTab();
        else renderSettingsTab();
    }

    private void renderHomeTab() {
        LinearLayout inputCard = makeCard();
        TextView label = makeSectionTitle(isZh ? "粘贴链接或 BV 号" : "Paste Media URL or Bilibili BV ID");
        inputCard.addView(label);

        String priorInput = urlInput != null ? urlInput.getText().toString() : "";
        urlInput = new EditText(this);
        urlInput.setText(priorInput);
        urlInput.setMinLines(2);
        urlInput.setMaxLines(4);
        urlInput.setTextSize(14f);
        urlInput.setTextColor(cText());
        urlInput.setHintTextColor(cMuted());
        urlInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        urlInput.setBackground(roundedBox(cField(), 10, 1, cBorder()));
        urlInput.setHint(isZh
                ? "支持 BV号 / bilibili.com / b23.tv / .m3u8 / .mpd / .mp4（多行批量）"
                : "Bilibili BV / bilibili.com / b23.tv / .m3u8 / .mpd / .mp4");
        inputCard.addView(urlInput, marginTop(8));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button pasteBtn = makeActionButton(isZh ? "粘贴" : "Paste", "#334155");
        pasteBtn.setContentDescription("Paste URL from clipboard");
        pasteBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null && cm.hasPrimaryClip()) {
                    ClipData.Item item = cm.getPrimaryClip().getItemAt(0);
                    if (item != null && item.getText() != null) {
                        urlInput.setText(extractLinkFromShareText(item.getText().toString()));
                        runProbe();
                        return;
                    }
                }
                Toast.makeText(MainActivity.this, isZh ? "剪贴板为空" : "Clipboard is empty", Toast.LENGTH_SHORT).show();
            }
        });
        Button probeBtn = makeActionButton(isZh ? "探测画质" : "Probe", "#059669");
        probeBtn.setContentDescription("Probe available media qualities");
        probeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { runProbe(); }
        });
        Button batchBtn = makeActionButton(isZh ? "批量入队" : "Batch", "#2563EB");
        batchBtn.setContentDescription("Queue all pasted URLs");
        batchBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { enqueueBatchFromInput(); }
        });

        LinearLayout.LayoutParams bp1 = new LinearLayout.LayoutParams(0, dp(42), 0.75f);
        bp1.setMargins(0, 0, dp(6), 0);
        LinearLayout.LayoutParams bp2 = new LinearLayout.LayoutParams(0, dp(42), 1.2f);
        bp2.setMargins(0, 0, dp(6), 0);
        actions.addView(pasteBtn, bp1);
        actions.addView(probeBtn, bp2);
        actions.addView(batchBtn, new LinearLayout.LayoutParams(0, dp(42), 0.9f));
        inputCard.addView(actions, marginTop(10));
        contentContainer.addView(inputCard);

        // Live Progress Strip
        LinearLayout progCard = makeCard();
        liveProgressText = new TextView(this);
        liveProgressText.setTextSize(13f);
        liveProgressText.setTextColor(cText());
        liveProgressText.setText(currentProbeSummary.isEmpty()
                ? (isZh ? "就绪：支持系统分享菜单直达，成片经容器与轨道校验后保存至 Downloads/VideoSave" : "Ready: Share links from any app. Outputs verified before saving to Downloads/VideoSave.")
                : currentProbeSummary);
        progCard.addView(liveProgressText);
        liveProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        liveProgressBar.setMax(100);
        progCard.addView(liveProgressBar, marginTop(8));
        contentContainer.addView(progCard, marginTop(12));

        // Media Preview & Quality Picker Card
        previewCard = makeCard();
        probeStatusView = new TextView(this);
        probeStatusView.setTextSize(14f);
        probeStatusView.setTypeface(Typeface.DEFAULT_BOLD);
        probeStatusView.setTextColor(cText());
        probeStatusView.setText(currentTitle.isEmpty()
                ? (isZh ? "探测结果与画质选择" : "Detected Media & Quality Options")
                : currentTitle);
        previewCard.addView(probeStatusView);

        candidatesContainer = new LinearLayout(this);
        candidatesContainer.setOrientation(LinearLayout.VERTICAL);
        previewCard.addView(candidatesContainer, marginTop(8));
        renderCandidatesIntoContainer();
        contentContainer.addView(previewCard, marginTop(12));
    }

    private void renderCandidatesIntoContainer() {
        if (candidatesContainer == null) return;
        candidatesContainer.removeAllViews();
        if (currentCandidates.isEmpty()) {
            TextView hint = new TextView(this);
            hint.setTextSize(12.5f);
            hint.setTextColor(cMuted());
            hint.setText(isZh
                    ? "输入链接并点击「探测画质」查看实际可用分辨率与协议（自动识别 Bilibili / 静态 DASH / HLS / HTTP）。"
                    : "Tap Probe to inspect available resolutions and verify stream accessibility.");
            candidatesContainer.addView(hint);
            return;
        }
        for (final MediaProbeEngine.QualityCandidate c : currentCandidates) {
            boolean ok = "available".equals(c.availability) || "unknown".equals(c.availability);
            String bgHex = "available".equals(c.availability) ? "#059669"
                    : "restricted".equals(c.availability) ? "#B45309" : "#475569";
            Button b = makeActionButton((isZh ? "下载 · " : "Download · ") + c.label, bgHex);
            b.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if ("restricted".equals(c.availability) || "drm".equals(c.availability)) {
                        Toast.makeText(MainActivity.this,
                                isZh ? "受服务器访问限制或 DRM 保护，VideoSave 绝不绕过限制" : "Access restricted or DRM protected (not bypassed)",
                                Toast.LENGTH_LONG).show();
                        return;
                    }
                    startCandidateDownload(c, currentTitle);
                    activeTab = 1;
                    renderActiveTab();
                }
            });
            if (!ok) b.setAlpha(0.75f);
            candidatesContainer.addView(b, marginTop(6));
        }
    }

    private void renderQueueTab() {
        LinearLayout ctrlRow = new LinearLayout(this);
        ctrlRow.setOrientation(LinearLayout.HORIZONTAL);
        Button pauseBtn = makeActionButton(isZh ? "全部暂停" : "Pause All", "#D97706");
        pauseBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { sendServiceAction(DownloadService.ACTION_PAUSE, null); }
        });
        Button resumeBtn = makeActionButton(isZh ? "全部继续" : "Resume All", "#059669");
        resumeBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { sendServiceAction(DownloadService.ACTION_RESUME_ALL, null); }
        });
        Button clearBtn = makeActionButton(isZh ? "清理已完成" : "Clear Done", "#475569");
        clearBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                DownloadQueueStore.clearCompleted(MainActivity.this);
                renderActiveTab();
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(40), 1f);
        lp.setMargins(0, 0, dp(6), 0);
        ctrlRow.addView(pauseBtn, lp);
        ctrlRow.addView(resumeBtn, lp);
        ctrlRow.addView(clearBtn, new LinearLayout.LayoutParams(0, dp(40), 1f));
        contentContainer.addView(ctrlRow);

        List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(this);
        if (tasks.isEmpty()) {
            LinearLayout emptyCard = makeCard();
            TextView tv = new TextView(this);
            tv.setTextColor(cMuted());
            tv.setText(isZh ? "当前队列为空。在首页探测媒体或通过系统分享菜单发送链接即可开始。" : "Queue is empty. Probe a URL on Home or share from another app.");
            emptyCard.addView(tv);
            contentContainer.addView(emptyCard, marginTop(12));
            return;
        }
        for (final DownloadQueueStore.QueuedTask t : tasks) {
            LinearLayout card = makeCard();
            TextView title = new TextView(this);
            title.setText(t.title + " [" + t.kind + "]");
            title.setTextSize(14f);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setTextColor(cText());
            card.addView(title);

            TextView meta = new TextView(this);
            meta.setTextSize(12f);
            meta.setTextColor(cMuted());
            meta.setText(t.status.toUpperCase() + " · " + t.percent + "% · " + (t.statusText == null ? "" : t.statusText));
            card.addView(meta, marginTop(4));

            ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            pb.setMax(100);
            pb.setProgress(t.percent);
            card.addView(pb, marginTop(6));

            if ("error".equals(t.status) || "paused".equals(t.status) || "cancelled".equals(t.status)) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                Button retry = makeActionButton(isZh ? "重试 / 续传" : "Retry / Resume", "#2563EB");
                retry.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) { sendServiceAction(DownloadService.ACTION_RETRY, t.id); }
                });
                row.addView(retry, new LinearLayout.LayoutParams(0, dp(36), 1f));
                card.addView(row, marginTop(8));
            } else if ("downloading".equals(t.status) || "queued".equals(t.status)) {
                Button cancel = makeActionButton(isZh ? "取消此任务" : "Cancel Task", "#DC2626");
                cancel.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) { sendServiceAction(DownloadService.ACTION_CANCEL, t.id); }
                });
                card.addView(cancel, marginTop(8));
            }
            contentContainer.addView(card, marginTop(10));
        }
    }

    private void renderHistoryTab() {
        List<DownloadHistoryStore.Record> records = DownloadHistoryStore.load(this);
        if (records.isEmpty()) {
            LinearLayout card = makeCard();
            TextView tv = new TextView(this);
            tv.setTextColor(cMuted());
            tv.setText(isZh ? "暂无历史记录。" : "No completed downloads yet.");
            card.addView(tv);
            contentContainer.addView(card);
            return;
        }
        int shown = Math.min(records.size(), 25);
        for (int idx = 0; idx < shown; idx++) {
            final DownloadHistoryStore.Record r = records.get(idx);
            LinearLayout card = makeCard();
            TextView title = new TextView(this);
            title.setText(("done".equals(r.status) ? "✓ " : "✗ ") + r.title);
            title.setTextSize(14f);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setTextColor(cText());
            card.addView(title);

            TextView sub = new TextView(this);
            sub.setTextSize(12f);
            sub.setTextColor(cMuted());
            sub.setText(r.displayPath + (r.bytes > 0 ? " · " + MediaProbeEngine.formatSize(r.bytes) : ""));
            card.addView(sub, marginTop(4));

            if ("done".equals(r.status) && r.contentUri != null && !r.contentUri.isEmpty()) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                Button play = makeActionButton(isZh ? "预览播放" : "Play", "#059669");
                play.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        try {
                            Intent view = new Intent(Intent.ACTION_VIEW);
                            view.setDataAndType(Uri.parse(r.contentUri), r.title.endsWith(".m4a") ? "audio/*" : "video/*");
                            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(view);
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, r.displayPath, Toast.LENGTH_LONG).show();
                        }
                    }
                });
                Button share = makeActionButton(isZh ? "系统分享" : "Share", "#334155");
                share.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        try {
                            Intent s = new Intent(Intent.ACTION_SEND);
                            s.setType(r.title.endsWith(".m4a") ? "audio/*" : "video/*");
                            s.putExtra(Intent.EXTRA_STREAM, Uri.parse(r.contentUri));
                            s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(Intent.createChooser(s, r.title));
                        } catch (Exception ignored) {}
                    }
                });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(36), 1f);
                lp.setMargins(0, 0, dp(8), 0);
                row.addView(play, lp);
                row.addView(share, new LinearLayout.LayoutParams(0, dp(36), 1f));
                card.addView(row, marginTop(8));
            }
            contentContainer.addView(card, marginTop(10));
        }
    }

    private void renderSettingsTab() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);

        LinearLayout prefCard = makeCard();
        prefCard.addView(makeSectionTitle(isZh ? "下载与网络设置" : "Download & Network Settings"));

        folderInput = new EditText(this);
        folderInput.setText(sp.getString("folder", "VideoSave"));
        folderInput.setTextColor(cText());
        folderInput.setHintTextColor(cMuted());
        folderInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        folderInput.setBackground(roundedBox(cField(), 10, 1, cBorder()));
        folderInput.setHint(isZh ? "Downloads 子目录（默认 VideoSave）" : "Subfolder under Downloads");
        prefCard.addView(folderInput, marginTop(8));

        refererInput = new EditText(this);
        refererInput.setText(sp.getString("referer", ""));
        refererInput.setTextColor(cText());
        refererInput.setHintTextColor(cMuted());
        refererInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        refererInput.setBackground(roundedBox(cField(), 10, 1, cBorder()));
        refererInput.setHint(isZh ? "可选默认 Referer 请求头" : "Optional default Referer header");
        prefCard.addView(refererInput, marginTop(8));

        wifiOnlyBox = new CheckBox(this);
        wifiOnlyBox.setChecked(wifiOnly);
        wifiOnlyBox.setTextColor(cText());
        wifiOnlyBox.setText(isZh ? "仅在 Wi-Fi 下下载（移动流量自动暂停）" : "Wi-Fi only (pause automatically on cellular data)");
        wifiOnlyBox.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                wifiOnly = isChecked;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("wifi_only", wifiOnly).apply();
            }
        });
        prefCard.addView(wifiOnlyBox, marginTop(8));

        Button saveBtn = makeActionButton(isZh ? "保存设置" : "Save Settings", "#2563EB");
        saveBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("folder", folderInput.getText().toString().trim().isEmpty() ? "VideoSave" : folderInput.getText().toString().trim())
                        .putString("referer", refererInput.getText().toString().trim())
                        .apply();
                Toast.makeText(MainActivity.this, isZh ? "设置已保存" : "Settings saved", Toast.LENGTH_SHORT).show();
            }
        });
        prefCard.addView(saveBtn, marginTop(10));
        contentContainer.addView(prefCard);

        // Component, Storage, Signing Fingerprint & Data Migration Card
        LinearLayout infoCard = makeCard();
        infoCard.addView(makeSectionTitle(isZh ? "版本、签名指纹与数据迁移" : "Build, Signing & Data Migration"));
        String verText = getInstalledVersionName();
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            verText = pi.versionName + " (versionCode=" + pi.getLongVersionCode() + ")";
        } catch (Exception ignored) {}
        String freeStr = "unknown";
        try {
            StatFs sf = new StatFs(getCacheDir().getAbsolutePath());
            freeStr = MediaProbeEngine.formatSize(sf.getAvailableBytes());
        } catch (Exception ignored) {}
        String certFp = getSigningCertFingerprintShort();

        TextView details = new TextView(this);
        details.setTextSize(12.5f);
        details.setTextColor(cMuted());
        details.setText((isZh
                ? "版本：" + verText + "\n签名证书 SHA-256：" + certFp + "\n可用存储：" + freeStr
                + "\n内置引擎：Bilibili 原生（免 Termux/Python）、静态 DASH（MediaMuxer 封装）、HLS（SHA-256 续传+AES-128）、严格 HTTP 416 校验"
                + "\n华为 Mate 60 Pro / HarmonyOS：HarmonyOS 4.x 可直接安装本 APK；HarmonyOS NEXT 纯血版不支持原生 APK。"
                + "\n升级迁移提示：从临时 Debug 版切换到正式签名版前，请先点击下方「导出历史备份」，卸载旧版安装新版后再导入。"
                : "Version: " + verText + "\nSigning Cert SHA-256: " + certFp + "\nAvailable storage: " + freeStr
                + "\nEngines: Native Bilibili, Static DASH (MediaMuxer), Resumable HLS (SHA-256 + AES-128), Strict HTTP 416 validator"
                + "\nHuawei Mate 60 Pro / HarmonyOS: Supported on HarmonyOS 4.x; HarmonyOS NEXT does not support native APKs."
                + "\nUpgrade migration: Before switching from a debug APK to a release-signed APK, export your history backup below first."));
        infoCard.addView(details, marginTop(6));

        Button exportBackupBtn = makeActionButton(isZh ? "导出历史与队列备份 (JSON)" : "Export History Backup (JSON)", "#059669");
        exportBackupBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) { exportMigrationBackup(); }
        });
        infoCard.addView(exportBackupBtn, marginTop(10));
        contentContainer.addView(infoCard, marginTop(12));
    }

    private String getInstalledVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "1.3.1";
        }
    }

    private String getSigningCertFingerprintShort() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(
                    getPackageName(),
                    Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
            Signature sig = null;
            if (Build.VERSION.SDK_INT >= 28 && pi.signingInfo != null) {
                Signature[] sigs = pi.signingInfo.getApkContentsSigners();
                if (sigs != null && sigs.length > 0) sig = sigs[0];
            } else if (pi.signatures != null && pi.signatures.length > 0) {
                sig = pi.signatures[0];
            }
            if (sig == null) return "unavailable";
            byte[] d = MessageDigest.getInstance("SHA-256").digest(sig.toByteArray());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < Math.min(8, d.length); i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format(Locale.US, "%02X", d[i] & 0xff));
            }
            return sb.toString() + "...";
        } catch (Exception e) {
            return "unavailable";
        }
    }

    private void exportMigrationBackup() {
        try {
            String json = DownloadHistoryStore.exportMigrationJson(this);
            byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
            String name = "videosave-backup.json";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VideoSave");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri != null) {
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os != null) { try { os.write(bytes); } finally { os.close(); } }
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VideoSave");
                if (!dir.exists()) dir.mkdirs();
                FileOutputStream fos = new FileOutputStream(new File(dir, name));
                try { fos.write(bytes); } finally { fos.close(); }
            }
            Toast.makeText(this, isZh ? "已导出备份至 Downloads/VideoSave/videosave-backup.json" : "Backup saved to Downloads/VideoSave/videosave-backup.json", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "Export failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void runProbe() {
        final String raw = urlInput != null ? urlInput.getText().toString().trim() : "";
        final String firstLine = raw.split("\\r?\\n")[0].trim();
        final String ref = getSharedPreferences(PREFS, MODE_PRIVATE).getString("referer", "");
        if (firstLine.isEmpty()) {
            Toast.makeText(this, isZh ? "请先粘贴媒体链接或 BV 号" : "Paste a URL or BV ID first", Toast.LENGTH_SHORT).show();
            return;
        }
        currentProbeSummary = isZh ? "正在探测真实可用画质与协议..." : "Probing available qualities...";
        if (liveProgressText != null) liveProgressText.setText(currentProbeSummary);
        currentCandidates.clear();
        renderCandidatesIntoContainer();

        new Thread(new Runnable() {
            @Override
            public void run() {
                final MediaProbeEngine.ProbeResult res = MediaProbeEngine.probe(firstLine, null, ref);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        currentTitle = res.title;
                        currentCandidates = new ArrayList<MediaProbeEngine.QualityCandidate>(res.candidates);
                        currentProbeSummary = "[" + res.status.toUpperCase() + "] " + res.message;
                        if (liveProgressText != null) liveProgressText.setText(currentProbeSummary);
                        if (probeStatusView != null) probeStatusView.setText(currentTitle.isEmpty() ? "Result" : currentTitle);
                        renderCandidatesIntoContainer();
                    }
                });
            }
        }).start();
    }

    private void enqueueBatchFromInput() {
        String raw = urlInput != null ? urlInput.getText().toString().trim() : "";
        if (raw.isEmpty()) return;
        String[] lines = raw.split("\\r?\\n");
        int count = 0;
        for (String line : lines) {
            final String u = line.trim();
            if (BilibiliResolver.isBilibiliInput(u)) {
                count++;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        MediaProbeEngine.ProbeResult res = BilibiliResolver.probe(u);
                        if ("ok".equals(res.status) && !res.candidates.isEmpty()) {
                            final MediaProbeEngine.QualityCandidate best = res.candidates.get(0);
                            final String title = res.title;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() { startCandidateDownload(best, title); }
                            });
                        }
                    }
                }).start();
            } else if (u.startsWith("http://") || u.startsWith("https://")) {
                String kind = u.toLowerCase().contains(".m3u8") ? "hls"
                        : u.toLowerCase().contains(".mpd") ? "dash" : "mp4";
                startCandidateDownload(new MediaProbeEngine.QualityCandidate(u, u, kind, 0, 0, -1, "available", 200),
                        MediaProbeEngine.inferTitle(u));
                count++;
            }
        }
        Toast.makeText(this, isZh ? ("已加入队列: " + count + " 项") : ("Queued " + count + " task(s)"), Toast.LENGTH_SHORT).show();
        if (count > 0) {
            activeTab = 1;
            renderActiveTab();
        }
    }

    private void startCandidateDownload(MediaProbeEngine.QualityCandidate c, String title) {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        Intent i = new Intent(this, DownloadService.class);
        i.setAction(DownloadService.ACTION_ENQUEUE);
        i.putExtra("url", c.url);
        if (c.audioUrl != null) i.putExtra("audioUrl", c.audioUrl);
        i.putExtra("title", (title == null || title.isEmpty()) ? MediaProbeEngine.inferTitle(c.url) : title);
        i.putExtra("kind", c.kind);
        i.putExtra("referer", c.refererOverride != null ? c.refererOverride : sp.getString("referer", ""));
        i.putExtra("folder", sp.getString("folder", "VideoSave"));
        if (!c.mirrorUrls.isEmpty()) i.putStringArrayListExtra("mirrorUrls", new ArrayList<String>(c.mirrorUrls));
        if (!c.audioMirrorUrls.isEmpty()) i.putStringArrayListExtra("audioMirrorUrls", new ArrayList<String>(c.audioMirrorUrls));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
        else startService(i);
    }

    private void sendServiceAction(String action, String taskId) {
        Intent i = new Intent(this, DownloadService.class);
        i.setAction(action);
        if (taskId != null) i.putExtra("taskId", taskId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && (DownloadService.ACTION_RESUME_ALL.equals(action) || DownloadService.ACTION_RETRY.equals(action))) {
            startForegroundService(i);
        } else {
            startService(i);
        }
    }

    private LinearLayout makeCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        card.setBackground(roundedBox(cSurface(), 14, 1, cBorder()));
        return card;
    }

    private TextView makeSectionTitle(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(14.5f);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setTextColor(cText());
        return tv;
    }

    private Button makeActionButton(String text, String hexColor) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(13f);
        b.setTextColor(Color.WHITE);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setBackground(roundedBox(Color.parseColor(hexColor), 10, 0, Color.TRANSPARENT));
        return b;
    }

    private Button makePillButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(12f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(46), dp(34));
        lp.setMargins(dp(6), 0, 0, 0);
        b.setLayoutParams(lp);
        return b;
    }

    private void stylePillButton(Button b, boolean accent) {
        b.setTextColor(accent ? Color.WHITE : cText());
        b.setBackground(roundedBox(accent ? Color.parseColor("#2563EB") : cSurface(), 10, 1, cBorder()));
    }

    private GradientDrawable roundedBox(int fillColor, int radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fillColor);
        d.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) d.setStroke(dp(strokeDp), strokeColor);
        return d;
    }

    private int cBg() { return isDark ? Color.parseColor("#0B1120") : Color.parseColor("#F1F5F9"); }
    private int cSurface() { return isDark ? Color.parseColor("#111C33") : Color.WHITE; }
    private int cField() { return isDark ? Color.parseColor("#0F172A") : Color.parseColor("#F8FAFC"); }
    private int cBorder() { return isDark ? Color.parseColor("#1E293B") : Color.parseColor("#CBD5E1"); }
    private int cText() { return isDark ? Color.parseColor("#F1F5F9") : Color.parseColor("#0F172A"); }
    private int cMuted() { return isDark ? Color.parseColor("#94A3B8") : Color.parseColor("#475569"); }

    private LinearLayout.LayoutParams marginTop(int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        return lp;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}

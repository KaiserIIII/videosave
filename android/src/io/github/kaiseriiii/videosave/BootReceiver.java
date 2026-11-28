package io.github.kaiseriiii.videosave;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.util.List;

/**
 * Resumes interrupted downloads automatically after device reboot when persisted tasks exist.
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        List<DownloadQueueStore.QueuedTask> tasks = DownloadQueueStore.load(context);
        boolean hasPending = false;
        for (DownloadQueueStore.QueuedTask t : tasks) {
            if ("queued".equals(t.status) || "downloading".equals(t.status)) {
                t.status = "queued";
                hasPending = true;
            }
        }
        if (!hasPending) return;
        DownloadQueueStore.save(context, tasks);
        Intent svc = new Intent(context, DownloadService.class);
        svc.setAction(DownloadService.ACTION_RESUME_ALL);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc);
            else context.startService(svc);
        } catch (Exception ignored) {}
    }
}

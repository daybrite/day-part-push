package dev.daybrite.push;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import dev.daybrite.day.bridge.DayRuntime;
import dev.daybrite.day.bridge.day_part_push_android_fcm.DayPartPushAndroidFcmBridge;
import org.json.JSONObject;

public final class DayMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        DayRuntime.startServices(getApplicationContext());
        DayPartPushAndroidFcmBridge.deliverToken(token);
    }
    @Override public void onMessageReceived(RemoteMessage message) {
        DayRuntime.startServices(getApplicationContext());
        try {
            JSONObject payload = new JSONObject();
            payload.put("id", message.getMessageId());
            payload.put("data", new JSONObject(message.getData()));
            RemoteMessage.Notification notification = message.getNotification();
            if (notification != null) {
                JSONObject display = new JSONObject();
                display.put("title", notification.getTitle());
                display.put("body", notification.getBody());
                payload.put("notification", display);
            }
            DayPartPushAndroidFcmBridge.deliverMessage(payload, false);
        } catch (org.json.JSONException e) { android.util.Log.e("Day", "Could not decode push message", e); }
    }
}

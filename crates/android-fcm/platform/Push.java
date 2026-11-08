import android.app.*;
import android.content.*;
import android.os.Bundle;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import dev.daybrite.day.bridge.DayRuntime;
import org.json.*;
import java.util.*;

private static long listener;
private static boolean initialized;
private static SharedPreferences preferences() {
    return DayRuntime.ctx.getApplicationContext().getSharedPreferences("day.push", Context.MODE_PRIVATE);
}
private static JSONObject object(Object... fields) {
    JSONObject result = new JSONObject();
    try { for (int i = 0; i < fields.length; i += 2) result.put((String)fields[i], fields[i+1]); }
    catch (JSONException e) { throw new IllegalArgumentException(e); }
    return result;
}
public static synchronized void deliver(JSONObject event) {
    if (listener != 0) { events_native_emit(listener, event.toString()); return; }
    try {
        JSONArray saved = new JSONArray(preferences().getString("events", "[]"));
        JSONArray next = new JSONArray();
        for (int i = Math.max(0, saved.length() - 31); i < saved.length(); i++) next.put(saved.get(i));
        next.put(event);
        preferences().edit().putString("events", next.toString()).commit();
    } catch (JSONException e) { android.util.Log.e("Day", "Could not buffer push event", e); }
}
public static void deliverToken(String value) {
    preferences().edit().putString("token", value).apply();
    deliver(object("event", "token", "token", object("provider", "fcm", "value", value)));
}
public static void deliverMessage(JSONObject payload, boolean opened) {
    deliver(object("event", "message", "payload", payload, "opened", opened));
}
public static synchronized void events_native(long token) throws JSONException {
    listener = token;
    String current = preferences().getString("token", null);
    if (current != null) events_native_emit(token, object("event", "token", "token", object("provider", "fcm", "value", current)).toString());
    JSONArray saved = new JSONArray(preferences().getString("events", "[]"));
    preferences().edit().remove("events").commit();
    for (int i = 0; i < saved.length(); i++) events_native_emit(token, saved.getJSONObject(i).toString());
}
private static void opened(Activity activity) {
    Intent intent = activity.getIntent();
    if (intent == null || !intent.hasExtra("google.message_id") || intent.getBooleanExtra("day.push.delivered", false)) return;
    intent.putExtra("day.push.delivered", true);
    JSONObject payload = new JSONObject();
    Bundle extras = intent.getExtras();
    try { for (String key : extras.keySet()) {
        Object value = extras.get(key);
        if (value instanceof String) payload.put(key, value);
    }} catch (JSONException e) { android.util.Log.e("Day", "Could not read notification tap", e); return; }
    deliverMessage(payload, true);
}
public static synchronized void initialize_native() {
    if (initialized) return;
    initialized = true;
    Application application = (Application)DayRuntime.ctx.getApplicationContext();
    application.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
        public void onActivityCreated(Activity a, Bundle b) { opened(a); }
        public void onActivityResumed(Activity a) { opened(a); }
        public void onActivityStarted(Activity a) {}
        public void onActivityPaused(Activity a) {}
        public void onActivityStopped(Activity a) {}
        public void onActivitySaveInstanceState(Activity a, Bundle b) {}
        public void onActivityDestroyed(Activity a) {}
    });
    if (DayRuntime.ctx instanceof Activity) opened((Activity)DayRuntime.ctx);
}
private static FirebaseMessaging messaging() {
    Context context = DayRuntime.ctx.getApplicationContext();
    if (FirebaseApp.getApps(context).isEmpty()) {
        FirebaseOptions options = FirebaseOptions.fromResource(context);
        if (options == null) throw new IllegalStateException("Add Firebase Android app resources before registering for push");
        FirebaseApp.initializeApp(context, options);
    }
    return FirebaseMessaging.getInstance();
}
public static void register_native(long done) {
    try {
        FirebaseMessaging messaging = messaging();
        messaging.setAutoInitEnabled(true);
        messaging.getToken().addOnCompleteListener(task -> {
            if (task.isSuccessful()) { deliverToken(task.getResult()); register_native_complete(done, ""); }
            else register_native_complete(done, String.valueOf(task.getException()));
        });
    } catch (Exception e) { register_native_complete(done, e.toString()); }
}
public static void unregister_native(long done) {
    try {
        FirebaseMessaging messaging = messaging();
        messaging.setAutoInitEnabled(false);
        messaging.deleteToken().addOnCompleteListener(task -> {
            if (task.isSuccessful()) { preferences().edit().remove("token").apply(); unregister_native_complete(done, ""); }
            else unregister_native_complete(done, String.valueOf(task.getException()));
        });
    } catch (Exception e) { unregister_native_complete(done, e.toString()); }
}

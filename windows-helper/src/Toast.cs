// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A live toast with a progress bar (files on their way), changed in place: its text and bar are
// bound to NotificationData, so each step updates them without a new toast (no sound, no banner
// again). Dismissed by the person: left alone until the end. main passes the app's
// AppUserModelID (its own toasts' one, which notifWatch never forwards).
//   toastProgress {aumid, tag, title, status, value (0..1, < 0: indeterminate), label}
//   toastDone {aumid, tag, title, text}: the bar's toast goes; a plain one says how it ended ('' title: nothing)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace MacShare
{
    static class Toast
    {
        const string Group = "twindesk-files";
        static readonly object gate = new object();
        static readonly Dictionary<string, uint> seq = new Dictionary<string, uint>(); // tag -> last update
        static readonly HashSet<string> gone = new HashSet<string>(); // dismissed: no more updates

        static string Esc(string s)
        {
            return SecurityElement.Escape(s ?? "");
        }

        public static void Progress(string aumid, string tag, string title, string status, double value, string label)
        {
            lock (gate)
            {
                if (gone.Contains(tag)) return;
                try
                {
                    ToastNotifier n = ToastNotificationManager.CreateToastNotifier(aumid);
                    NotificationData d = new NotificationData();
                    d.Values["title"] = title ?? "";
                    d.Values["status"] = status ?? "";
                    d.Values["value"] = value < 0 ? "indeterminate" : Math.Max(0, Math.Min(1, value)).ToString("0.###", CultureInfo.InvariantCulture);
                    d.Values["label"] = label ?? "";
                    uint s;
                    seq.TryGetValue(tag, out s);
                    d.SequenceNumber = ++s;
                    seq[tag] = s;
                    if (s > 1)
                    {
                        if (n.Update(d, tag, Group) == NotificationUpdateResult.NotificationNotFound) gone.Add(tag);
                        return;
                    }
                    XmlDocument x = new XmlDocument();
                    x.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><text>{title}</text>" +
                        "<progress value=\"{value}\" valueStringOverride=\"{label}\" status=\"{status}\"/>" +
                        "</binding></visual><audio silent=\"true\"/></toast>");
                    ToastNotification t = new ToastNotification(x);
                    t.Tag = tag;
                    t.Group = Group;
                    t.Data = d;
                    n.Show(t);
                }
                catch (Exception e) { Net.Log("toast: " + e.Message); }
            }
        }

        public static void Done(string aumid, string tag, string title, string text)
        {
            lock (gate)
            {
                seq.Remove(tag);
                gone.Remove(tag);
                try
                {
                    ToastNotificationManager.History.Remove(tag, Group, aumid);
                    if (string.IsNullOrEmpty(title)) return;
                    XmlDocument x = new XmlDocument();
                    x.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><text>" + Esc(title) + "</text>" +
                        (string.IsNullOrEmpty(text) ? "" : "<text>" + Esc(text) + "</text>") +
                        "</binding></visual><audio silent=\"true\"/></toast>");
                    ToastNotification t = new ToastNotification(x);
                    t.Tag = tag;
                    t.Group = Group;
                    ToastNotificationManager.CreateToastNotifier(aumid).Show(t);
                }
                catch (Exception e) { Net.Log("toast: " + e.Message); }
            }
        }
    }
}

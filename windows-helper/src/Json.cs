// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tiny wrapper over JavaScriptSerializer: parse a command line, read typed fields, write a line.
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace MacShare
{
    static class Json
    {
        static readonly JavaScriptSerializer S = new JavaScriptSerializer();

        public static Dictionary<string, object> Parse(string line)
        {
            return S.Deserialize<Dictionary<string, object>>(line);
        }

        public static string Write(Dictionary<string, object> d)
        {
            return S.Serialize(d);
        }

        public static string Str(Dictionary<string, object> d, string k, string def)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : def;
        }

        public static double Num(Dictionary<string, object> d, string k, double def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToDouble(v); } catch { return def; }
        }

        public static bool Has(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v != null;
        }

        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is bool ? (bool)v : def;
        }

        // An array of strings (non-strings skipped); null when the key is absent or not an array.
        public static List<string> Strs(Dictionary<string, object> d, string k)
        {
            object v;
            // JavaScriptSerializer hands nested arrays over as ArrayList (object[] in some paths): take either.
            System.Collections.IEnumerable arr = d != null && d.TryGetValue(k, out v) ? v as System.Collections.IEnumerable : null;
            if (arr == null || arr is string) return null;
            List<string> r = new List<string>();
            foreach (object o in arr) if (o is string) r.Add((string)o);
            return r;
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }
    }
}

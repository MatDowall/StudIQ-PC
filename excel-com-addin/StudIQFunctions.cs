using System;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography.X509Certificates;
using ExcelDna.Integration;
using Newtonsoft.Json.Linq;

namespace StudIQ.ExcelAddin
{
    public static class StudIQFunctions
    {
        // Use 127.0.0.1 directly — localhost resolves to ::1 (IPv6) first on Windows,
        // but the bridge only binds on 127.0.0.1 (IPv4).
        private const string Bridge = "https://127.0.0.1:3998";

        // Force TLS 1.2 — .NET 4.8 defaults to TLS 1.0/1.1 which tokio-rustls rejects.
        // Accept any cert presented by localhost (self-signed; we only ever connect to 127.0.0.1).
        static StudIQFunctions()
        {
            ServicePointManager.SecurityProtocol =
                SecurityProtocolType.Tls12 | SecurityProtocolType.Tls13;
        }

        private static readonly HttpClient Http = new(
            new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (_, _, _, _) => true
            })
        { Timeout = TimeSpan.FromSeconds(4) };

        private static object FetchValue(string path)
        {
            try
            {
                var resp = Http.GetAsync(Bridge + path).GetAwaiter().GetResult();
                if (!resp.IsSuccessStatusCode) return ExcelError.ExcelErrorNA;
                var body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                var json = JObject.Parse(body);
                if (json["error"] != null) return ExcelError.ExcelErrorNA;
                var val = json["value"];
                if (val == null || val.Type == JTokenType.Null) return 0.0;
                return val.Value<double>();
            }
            catch
            {
                return ExcelError.ExcelErrorNA;
            }
        }

        private static string FetchRaw(string path)
        {
            try
            {
                var resp = Http.GetAsync(Bridge + path).GetAwaiter().GetResult();
                return $"HTTP {(int)resp.StatusCode}: {resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()}";
            }
            catch (Exception ex)
            {
                var msgs = new System.Text.StringBuilder();
                for (var e = ex; e != null; e = e.InnerException)
                    msgs.Append($"{e.GetType().Name}: {e.Message} | ");
                return $"EXCEPTION: {msgs}";
            }
        }

        [ExcelFunction(Name = "STUDIQ.DEBUG",
            Description = "Returns raw JSON from the StudIQ bridge for a given API path (for debugging).",
            IsVolatile = true)]
        public static string StudiqDebug(
            [ExcelArgument(Description = "API path, e.g. /api/framing_size?groupId=4")] string path)
        {
            return FetchRaw(path);
        }

        [ExcelFunction(Name = "STUDIQ.QTY",
            Description = "Live quantity total for a StudIQ dimension group.",
            IsVolatile = true)]
        public static object StudiqQty(
            [ExcelArgument(Description = "Dimension group ID")] double groupId,
            [ExcelArgument(Description = "Display: length, area, wall_area, volume, count, perimeter")] object display)
        {
            var d = display is string s && !string.IsNullOrWhiteSpace(s) ? s : "length";
            return FetchValue($"/api/quantity?groupId={Uri.EscapeDataString(((long)groupId).ToString())}&display={Uri.EscapeDataString(d)}");
        }

        [ExcelFunction(Name = "STUDIQ.MEASUREMENT",
            Description = "Live quantity for a single StudIQ measurement.",
            IsVolatile = true)]
        public static object StudiqMeasurement(
            [ExcelArgument(Description = "Dimension group ID")] double groupId,
            [ExcelArgument(Description = "Measurement ID")] double measurementId,
            [ExcelArgument(Description = "Display: length, area, wall_area, volume, count")] object display)
        {
            var d = display is string s && !string.IsNullOrWhiteSpace(s) ? s : "length";
            return FetchValue($"/api/measurement?groupId={Uri.EscapeDataString(((long)groupId).ToString())}&measurementId={Uri.EscapeDataString(((long)measurementId).ToString())}&display={Uri.EscapeDataString(d)}");
        }

        [ExcelFunction(Name = "STUDIQ.FRAMING",
            Description = "Matching-timber lineal metres for a framing group (excludes lintels).",
            IsVolatile = true)]
        public static object StudiqFraming(
            [ExcelArgument(Description = "Timber-framing dimension group ID")] double groupId)
        {
            return FetchValue($"/api/framing_size?groupId={Uri.EscapeDataString(((long)groupId).ToString())}");
        }

        [ExcelFunction(Name = "STUDIQ.LINTEL",
            Description = "Total lineal metres for a specific lintel size in a framing group.",
            IsVolatile = true)]
        public static object StudiqLintel(
            [ExcelArgument(Description = "Timber-framing dimension group ID")] double groupId,
            [ExcelArgument(Description = "Lintel size, e.g. \"140x45\"")] string size)
        {
            return FetchValue($"/api/lintel_size?groupId={Uri.EscapeDataString(((long)groupId).ToString())}&size={Uri.EscapeDataString(size)}");
        }

        [ExcelFunction(Name = "STUDIQ.RATE",
            Description = "Unit rate from the StudIQ rate library.",
            IsVolatile = true)]
        public static object StudiqRate(
            [ExcelArgument(Description = "Rate ID")] double id)
        {
            return FetchValue($"/api/rate?id={Uri.EscapeDataString(((long)id).ToString())}");
        }

        [ExcelFunction(Name = "STUDIQ.CONST",
            Description = "Named project constant from StudIQ.",
            IsVolatile = true)]
        public static object StudiqConst(
            [ExcelArgument(Description = "Constant name, e.g. \"GFA\"")] string name)
        {
            return FetchValue($"/api/constant?name={Uri.EscapeDataString(name)}");
        }
    }
}

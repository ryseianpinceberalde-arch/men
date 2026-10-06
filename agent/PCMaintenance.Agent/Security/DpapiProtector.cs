using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PCMaintenance.Agent.Security;

public static class DpapiProtector
{
    private const int CryptProtectLocalMachine = 0x4;

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Length;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(ref DataBlob input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(ref DataBlob input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string Protect(string value) => Convert.ToBase64String(Transform(Encoding.UTF8.GetBytes(value), protect: true));

    public static string Unprotect(string encryptedValue) => Encoding.UTF8.GetString(Transform(Convert.FromBase64String(encryptedValue), protect: false));

    private static byte[] Transform(byte[] input, bool protect)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows DPAPI is required to protect agent credentials.");
        var inputMemory = Marshal.AllocHGlobal(input.Length);
        Marshal.Copy(input, 0, inputMemory, input.Length);
        var inputBlob = new DataBlob { Length = input.Length, Data = inputMemory };
        DataBlob outputBlob = default;
        IntPtr description = IntPtr.Zero;
        try
        {
            var succeeded = protect
                ? CryptProtectData(ref inputBlob, "PC Maintenance device credential", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectLocalMachine, out outputBlob)
                : CryptUnprotectData(ref inputBlob, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out outputBlob);
            if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not protect the device credential.");
            var result = new byte[outputBlob.Length];
            Marshal.Copy(outputBlob.Data, result, 0, outputBlob.Length);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(inputMemory);
            if (outputBlob.Data != IntPtr.Zero) LocalFree(outputBlob.Data);
            if (description != IntPtr.Zero) LocalFree(description);
        }
    }
}

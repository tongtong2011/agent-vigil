# 从 agnesd.exe（爱思办公本地后端）进程内存中读取 AGNES_SERVER__SECRET_KEY 环境变量。
# 该密钥由爱思办公桌面端每次启动 agnesd 时随机生成，仅存在于进程内存，不落盘。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File get-agnes-secret.ps1 -AgnesdPid 6808
# 输出: 成功时将密钥写入 stdout（由桥接服务捕获，不回显到任何界面）；失败输出错误前缀。
param(
    [Parameter(Mandatory = $true)]
    [int]$AgnesdPid
)

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AgnesSecretReader {
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, out int retLen);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }
    // x64：PEB+0x20=ProcessParameters；Parameters+0x80=Environment 指针；+0x3F0=EnvironmentSize
    public static string ReadEnvVar(int pid, string name) {
        IntPtr h = OpenProcess(0x0410, false, pid); // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
        if (h == IntPtr.Zero) return "OPEN_FAIL:" + Marshal.GetLastWin32Error();
        try {
            var pbi = new PROCESS_BASIC_INFORMATION(); int rl;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl) != 0) return "NTQI_FAIL";
            byte[] buf8 = new byte[8]; IntPtr read;
            if (!ReadProcessMemory(h, (IntPtr)((long)pbi.PebBaseAddress + 0x20), buf8, 8, out read)) return "PEB_READ_FAIL";
            IntPtr pp = (IntPtr)BitConverter.ToInt64(buf8, 0);
            if (!ReadProcessMemory(h, (IntPtr)((long)pp + 0x80), buf8, 8, out read)) return "PP_READ_FAIL";
            IntPtr env = (IntPtr)BitConverter.ToInt64(buf8, 0);
            byte[] buf4 = new byte[4];
            if (!ReadProcessMemory(h, (IntPtr)((long)pp + 0x3F0), buf4, 4, out read)) return "SIZE_READ_FAIL";
            int envSize = BitConverter.ToInt32(buf4, 0);
            if (envSize <= 0 || envSize > 4 * 1024 * 1024) envSize = 256 * 1024;
            byte[] envBuf = new byte[envSize];
            if (!ReadProcessMemory(h, env, envBuf, envSize, out read)) return "ENV_READ_FAIL";
            string text = Encoding.Unicode.GetString(envBuf, 0, (int)read);
            foreach (string line in text.Split('\0')) {
                if (line.StartsWith(name + "=", StringComparison.Ordinal)) return line.Substring(name.Length + 1);
            }
            return "KEY_NOT_FOUND";
        } finally { CloseHandle(h); }
    }
}
'@

try {
    Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
} catch { /* 已编译过则忽略 */ }

$r = [AgnesSecretReader]::ReadEnvVar($AgnesdPid, 'AGNES_SERVER__SECRET_KEY')
if ($r -eq 'OPEN_FAIL' -or $r.StartsWith('OPEN_FAIL:') -or $r -match '^(NTQI_FAIL|PEB_READ_FAIL|PP_READ_FAIL|SIZE_READ_FAIL|ENV_READ_FAIL|KEY_NOT_FOUND)$') {
    Write-Output "ERR:$r"
    exit 1
}
Write-Output $r

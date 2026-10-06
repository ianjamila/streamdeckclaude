// cputemp — reads Apple SMC CPU temperature sensors without root.
//
//   cputemp            print one JSON sample and exit
//   cputemp --watch N  print one JSON line every N ms until stdin closes
//
// Output: {"avg":74.8,"max":93.6,"n":112}  (degrees C; n = sensors read)
// CPU sensors are the float keys starting "Tp" (performance cores) or "Te"
// (efficiency cores) — the same rule macmon/Stats use on Apple Silicon. The
// key list is enumerated once; each sample only reads those keys.
#include <IOKit/IOKitLib.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct { char major, minor, build, reserved; uint16_t release; } smc_vers;
typedef struct { uint16_t version, length; uint32_t cpu, gpu, mem; } smc_plimit;
typedef struct { uint32_t dataSize, dataType; uint8_t dataAttributes; } smc_keyinfo;
typedef struct {
  uint32_t key;
  smc_vers vers;
  smc_plimit plimit;
  smc_keyinfo info;
  uint8_t result, status, data8;
  uint32_t data32;
  uint8_t bytes[32];
} smc_data;

enum { CMD_READ = 5, CMD_INDEX = 8, CMD_INFO = 9, MAX_KEYS = 512 };

static io_connect_t conn;
static uint32_t keys[MAX_KEYS];
static int nkeys;

static uint32_t fourcc(const char *s) {
  return ((uint32_t)s[0] << 24) | ((uint32_t)s[1] << 16) | ((uint32_t)s[2] << 8) | (uint32_t)s[3];
}

static int smc_call(smc_data *in, smc_data *out) {
  size_t size = sizeof(smc_data);
  if (IOConnectCallStructMethod(conn, 2, in, sizeof(smc_data), out, &size) != kIOReturnSuccess) return -1;
  return out->result ? -1 : 0;
}

static int smc_info(uint32_t key, smc_keyinfo *info) {
  smc_data in = {0}, out = {0};
  in.key = key;
  in.data8 = CMD_INFO;
  if (smc_call(&in, &out)) return -1;
  *info = out.info;
  return 0;
}

static int smc_read(uint32_t key, uint32_t size, uint8_t *bytes) {
  smc_data in = {0}, out = {0};
  in.key = key;
  in.info.dataSize = size;
  in.data8 = CMD_READ;
  if (smc_call(&in, &out)) return -1;
  memcpy(bytes, out.bytes, 32);
  return 0;
}

static void find_cpu_keys(void) {
  smc_keyinfo info;
  uint8_t b[32];
  if (smc_info(fourcc("#KEY"), &info) || smc_read(fourcc("#KEY"), info.dataSize, b)) return;
  uint32_t total = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
  for (uint32_t i = 0; i < total && nkeys < MAX_KEYS; i++) {
    smc_data in = {0}, out = {0};
    in.data8 = CMD_INDEX;
    in.data32 = i;
    if (smc_call(&in, &out)) continue;
    uint32_t k = out.key;
    char c0 = (char)(k >> 24), c1 = (char)(k >> 16);
    if (c0 != 'T' || (c1 != 'p' && c1 != 'e')) continue;
    if (smc_info(k, &info) || info.dataType != fourcc("flt ") || info.dataSize != 4) continue;
    keys[nkeys++] = k;
  }
}

static void sample(void) {
  double sum = 0, max = 0;
  int n = 0;
  uint8_t b[32];
  for (int i = 0; i < nkeys; i++) {
    if (smc_read(keys[i], 4, b)) continue;
    float f;
    memcpy(&f, b, 4);
    // Unused/parked sensors read 0 or garbage; keep plausible die temps only.
    if (!(f > 5 && f < 150)) continue;
    sum += f;
    if (f > max) max = f;
    n++;
  }
  if (n) printf("{\"avg\":%.1f,\"max\":%.1f,\"n\":%d}\n", sum / n, max, n);
  else printf("{\"error\":\"no CPU temperature sensors\"}\n");
  fflush(stdout);
}

// Exit when the parent (the Stream Deck plugin) goes away and stdin closes,
// so a crashed plugin never leaves an orphan polling the SMC.
static void *watch_stdin(void *arg) {
  (void)arg;
  char buf[64];
  while (read(STDIN_FILENO, buf, sizeof buf) > 0) {}
  exit(0);
}

int main(int argc, char **argv) {
  io_service_t svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!svc || IOServiceOpen(svc, mach_task_self(), 0, &conn) != kIOReturnSuccess) {
    printf("{\"error\":\"cannot open AppleSMC\"}\n");
    return 1;
  }
  IOObjectRelease(svc);
  find_cpu_keys();

  if (argc == 3 && strcmp(argv[1], "--watch") == 0) {
    long ms = strtol(argv[2], NULL, 10);
    if (ms < 250) ms = 250;
    pthread_t t;
    pthread_create(&t, NULL, watch_stdin, NULL);
    for (;;) {
      sample();
      usleep((useconds_t)ms * 1000);
    }
  }
  sample();
  return nkeys ? 0 : 1;
}

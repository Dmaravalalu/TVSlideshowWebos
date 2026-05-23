# Mounting the external HDD via fstab

The slideshow service runs as your unprivileged user, so the HDD must be
mounted somewhere it can read. The recommended location is `/mnt/photos`.

## 1. Identify the disk

Plug the drive in, then run:

```bash
sudo blkid
```

Look for a line like:

```
/dev/sdb1: UUID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" TYPE="ext4" ...
```

Note the **UUID** and the **TYPE** (ext4 / ntfs / exfat). We'll mount by UUID so
the entry is stable across reboots regardless of which `/dev/sdX` slot the
kernel assigns.

## 2. Create the mount point

```bash
sudo mkdir -p /mnt/photos
sudo chown $USER:$USER /mnt/photos
```

## 3. Add the fstab line

Edit `/etc/fstab` and append **one** line matching your filesystem type. Replace
`<UUID>` with the value from step 1.

### ext4 (Linux-native, fastest)

```
UUID=<UUID>  /mnt/photos  ext4  defaults,nofail,x-systemd.device-timeout=5s  0  2
```

### NTFS (drive previously used on Windows)

Install the NTFS driver if it isn't already:

```bash
sudo apt install -y ntfs-3g
```

Then:

```
UUID=<UUID>  /mnt/photos  ntfs-3g  defaults,nofail,uid=1000,gid=1000,umask=022,x-systemd.device-timeout=5s  0  0
```

Replace `uid=1000,gid=1000` with the output of `id -u` and `id -g` for the user
running the service.

### exFAT (cross-platform formatted drive)

```bash
sudo apt install -y exfat-fuse exfatprogs
```

```
UUID=<UUID>  /mnt/photos  exfat  defaults,nofail,uid=1000,gid=1000,umask=022,x-systemd.device-timeout=5s  0  0
```

## 4. Test the mount

```bash
sudo systemctl daemon-reload
sudo mount -a
ls /mnt/photos
```

If `ls` shows your `YYYY/MM/` folders, you're done. Reboot once to confirm it
re-mounts on its own.

## Notes

- `nofail` means the system still boots if the drive is unplugged. Without it,
  systemd will drop you into emergency mode after a missing-disk timeout.
- `x-systemd.device-timeout=5s` keeps boot fast when the drive is missing.
- If you ever need to change the mount point, update both `/etc/fstab` and the
  setup page in the slideshow's web UI (the media root is stored in
  `~/.config/slideshow/config.json`).

Import("env")

import os


def merge_firmware(source, target, env):
    build_dir = env.subst("$BUILD_DIR")
    program_name = env.subst("$PROGNAME")
    framework_dir = env.PioPlatform().get_package_dir("framework-arduinoespressif32")
    images = [
        (0x0000, "bootloader.bin"),
        (0x8000, "partitions.bin"),
        (0xE000, os.path.join(framework_dir, "tools", "partitions", "boot_app0.bin")),
        (0x10000, program_name + ".bin"),
    ]
    output_path = os.path.join(env.subst("$PROJECT_DIR"), "firmware-esp32s3.bin")
    temporary_path = output_path + ".tmp"

    position = 0
    with open(temporary_path, "wb") as output:
        for address, filename in images:
            image_path = filename if os.path.isabs(filename) else os.path.join(build_dir, filename)
            if not os.path.isfile(image_path):
                raise RuntimeError("Firmware image component not found: " + image_path)
            if address < position:
                raise RuntimeError("Firmware image overlaps at address 0x%X" % address)

            output.write(b"\xFF" * (address - position))
            with open(image_path, "rb") as image_file:
                image = image_file.read()
            output.write(image)
            position = address + len(image)
    os.replace(temporary_path, output_path)

    print("Combined ESP32-S3 firmware created: " + output_path)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", merge_firmware)

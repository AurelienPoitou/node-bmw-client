function parse_control_dsp(data) {
	data.command = 'con';
	data.value   = 'DSP - ';

	switch (data.msg[1]) {
		case 0x08 : data.value += 'memory get';                break;
		case 0x09 : data.value += 'EQ button: concert hall';   break;
		case 0x0A : data.value += 'EQ button: jazz club';      break;
		case 0x0B : data.value += 'EQ button: cathedral';      break;
		case 0x0C : data.value += 'EQ button: memory 1';       break;
		case 0x0D : data.value += 'EQ button: memory 2';       break;
		case 0x0E : data.value += 'EQ button: memory 3';       break;
		case 0x0F : data.value += 'EQ button: DSP off';        break;
		case 0x28 : data.value += 'EQ button: unknown (0x28)'; break;

		case 0x15 : {
			data.value += 'EQ delta: 0x' + data.msg[2].toString(16);
			break;
		}

		case 0x90 : {
			switch (data.msg[2]) {
				case 0x00 : {
					data.value += 'EQ button: M-Audio off';

					// Not really the right place to set this var
					// It should be in the status from DSP itself
					update.status('dsp.m_audio', false, false);

					break;
				}
			}
			break;
		}

		case 0x91 : {
			switch (data.msg[2]) {
				case 0x00 : {
					data.value += 'EQ button: M-Audio on';

					// Not really the right place to set this var
					// It should be in the status from DSP itself
					update.status('dsp.m_audio', true, false);

					break;
				}
			}
			break;
		}

		// DSP memory
		case 0x95 : data = parse_dsp_memory(data); break;

		default : {
			data.value = Buffer.from(data.msg);
		}
	}

	return data;
}

/* eslint key-spacing : 0 */
function parse_dsp_memory(data) {
	data.value += 'memory set - ';

	// data.msg[2] :
	// 0x15        = DSP EQ delta update
	// 0x00 - 0x07 = room 0-7
	// 0x20 - 0x27 = echo 0-7

	// data.msg[3] : DSP EQ delta update bands
	// 0x00 = 80Hz
	// 0x20 = 200Hz
	// 0x40 = 500Hz
	// 0x60 = 1kHz
	// 0x80 = 2kHz
	// 0xA0 = 5kHz
	// 0xC0 = 12kHz
	//
	// 0x10 = negative value
	//
	// 0x00        = 0
	// 0x01 - 0x0A = +1 thru +10
	// 0x11 - 0x1A = -1 thru -10

	let amount;

	// Check if the command is DSP EQ delta update or echo/room size
	switch (data.msg[2] === 0x15) {
		case false : {
			// Check if the command is setting echo amount or room size and get the value
			switch (bitmask.test(data.msg[2], bitmask.b[5])) {
				// Room size
				case false : {
					data.value += 'room size - ';

					amount = data.msg[2];
					break;
				}

				// Echo
				case true : {
					data.value += 'echo amount - ';

					// Remove 0x20 from the value
					amount = bitmask.unset(data.msg[2], bitmask.b[5]);
				}
			}

			break;
		}

		case true : {
			const mask = bitmask.check(data.msg[3]).mask;

			const dsp_memory = {
				negative     : mask.bit4,
				low_batt_str : 'negative: ' + mask.bit4,

				band     : null,
				band_str : null,
				bands    : {
					'80Hz'  : !mask.b5 && !mask.b6 && !mask.b7 &&  mask.b8,
					'200Hz' :  mask.b5 && !mask.b6 && !mask.b7 && !mask.b8,
					'500Hz' : !mask.b5 &&  mask.b6 && !mask.b7 && !mask.b8,
					'1kHz'  :  mask.b5 &&  mask.b6 && !mask.b7 && !mask.b8,
					'2kHz'  : !mask.b5 && !mask.b6 &&  mask.b7 && !mask.b8,
					'5kHz'  :  mask.b5 && !mask.b6 &&  mask.b7 && !mask.b8,
					'12kHz' : !mask.b5 &&  mask.b6 &&  mask.b7 && !mask.b8,
				},
			};

			// Loop band object to populate log string
			for (const band in dsp_memory.bands) {
				if (dsp_memory.bands[band] === true) {
					dsp_memory.band     = band;
					dsp_memory.band_str = 'band: ' + band;
					break;
				}
			}

			// Assemble log string
			data.value += dsp_memory.band_str + ', ' + dsp_memory.negative_str;
		}
	}

	data.value += amount;

	return data;
}

function parse_control_lcd(data) {
	data.command = 'con';
	data.value   = 'LCD ';

	const mask_m1  = bitmask.check(data.msg[1]).mask;
	const parse_m1 = {
		on          : mask_m1.b4,
		source_name : null,
		source      : {
			gt   : mask_m1.b0,
			navj : mask_m1.b2,
			tv   : mask_m1.b1,
		},
	};

	// A little lazy
	switch (data.msg[1]) {
		case 0x00 : parse_m1.source_name = 'off';  break;
		case 0x11 : parse_m1.source_name = 'TV';   break;
		case 0x12 : parse_m1.source_name = 'GT';   break;
		case 0x14 : parse_m1.source_name = 'NAVJ'; break;
		default   : parse_m1.source_name = 'unknown \'' + Buffer.from([ data.msg[1] ]) + '\'';
	}

	update.status('gt.lcd.on',                 parse_m1.on,          false);
	update.status('gt.lcd.source.gt',          parse_m1.source.gt,   false);
	update.status('gt.lcd.source.source.navj', parse_m1.source.navj, false);
	update.status('gt.lcd.source.tv',          parse_m1.source.tv,   false);
	update.status('gt.lcd.source_name',        parse_m1.source_name, false);

	// Only if data.msg[2] is populated
	if (data.msg.length >= 3) {
		const mask_m2  = bitmask.check(data.msg[2]).mask;
		const parse_m2 = {
			aspect_ratio : mask_m2.b4 && '16:9' || '4:3',
			refresh_rate : mask_m2.b1 && '50Hz' || '60Hz',
			zoom         : mask_m2.b5,
		};

		// Update status object
		update.status('gt.lcd.aspect_ratio', parse_m2.aspect_ratio, false);
		update.status('gt.lcd.refresh_rate', parse_m2.refresh_rate, false);
		update.status('gt.lcd.zoom',         parse_m2.zoom,         false);
	}

	data.value += 'status: ' + status.gt.lcd.on + ', aspect ratio: ' + status.gt.lcd.aspect_ratio + ', refresh rate: ' + status.gt.lcd.refresh_rate + ', zoom: ' + status.gt.lcd.zoom + ', source: ' + status.gt.lcd.source_name;

	return data;
}

function select_menu(data) {
        const selected_index = data.msg[3];
        if (selected_index < 10) {
                if (status.gt.menu === 'main') {
                        if (selected_index === 0) { // Dashboard
                                dashboard_menu();
                        } else if (selected_index === 1) { // Device Selection
                                device_selection_menu();
                        } else if (selected_index === 2) { // Settings
                                settings_menu();
                        }
                } else if (status.gt.menu === 'dashboard') {
                        update.status('gt.menu', 'main', false);
                } else if (status.gt.menu === 'device_selection') {
                        if (selected_index === 0) { // Pairing Mode
                                write_index(0, 'Pairing', 0);
                                gt_buffer_flush();
                        } else if (selected_index === 1) { // Clear Pairing
                                device_selection_menu();
                        } else if (selected_index === 7) { // Back
                                main_menu();
                        } else {
                                const selected_device_id = selected_index - 2;
                                update.status('gt.selected_device.id', selected_device_id, false);
                        }
                } else if (status.gt.menu === 'settings') {
                        if (selected_index === 0) { // About
                                settings_about_menu();
                        } else if (selected_index === 1) { // Audio
                                settings_audio_menu();
                        } else if (selected_index === 2) { // Calls
                                settings_calls_menu();
                        } else if (selected_index === 3) { // Comfort
                                settings_confort_menu();
                        } else if (selected_index === 4) { // UI
                                settings_ui_menu();
                        } else if (selected_index === 7) { // Back
                                main_menu();
                        }
                } else if (status.gt.menu === 'about') {
                        settings_about_update(selected_index);
                } else if (status.gt.menu === 'audio') {
                        settings_audio_update(selected_index);
                } else if (status.gt.menu === 'calls') {
                        settings_calls_update(selected_index);
                } else if (status.gt.menu === 'comfort') {
                        settings_comfort_update(selected_index);
                } else if (status.gt.menu === 'ui') {
                        settings_ui_update(selected_index);
                }
        }
        return data;
}

function dashboard_menu() {
        dashboard_update();
        update.status('gt.menu', 'dashboard', false);
}

function dashboard_update() {
        
}

function settings_about_menu() {
        write_title_index('About');
        write_index(0, 'Parameter 1', 0);
        write_index(1, 'Parameter 2', 0);
        write_index(2, 'Parameter 3', 4);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'about', false);
}

function settings_about_update(selected_index) {
        if (selected_index === 7) { // Back
                settings_menu();
        }
}

function settings_audio_menu() {
        write_title_index('Audio');
        write_index(0, 'Parameter 1', 0);
        write_index(1, 'Parameter 2', 0);
        write_index(2, 'Parameter 3', 4);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'audio', false);
}

function settings_audio_update(selected_index) {
        if (selected_index === 7) { // Back
                settings_menu();
        }
        if (selected_index !== 7) {
                gt_buffer_flush();
        }
}

function settings_calls_menu() {
        write_title_index('Calls');
        write_index(0, 'Parameter 1', 0);
        write_index(1, 'Parameter 2', 0);
        write_index(2, 'Parameter 3', 4);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'calls', false);
}

function settings_calls_update(selected_index) {
        if (selected_index === 7) { // Back
                settings_menu();
        }
        if (selected_index !== 7) {
                gt_buffer_flush();
        }
}

function settings_comfort_menu() {
        write_title_index('Comfort');
        write_index(0, 'Comfort Turn', 0);
        write_index(1, 'Comfort Lock', 0);
        write_index(2, 'Navigation Auto Zoom', 1);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'comfort', false);
}

function settings_comfort_update(selected_index) {
        if (selected_index === 0) { // Comfort Turn
                write_index(selected_index, 'Comfort Turn - Off', 0);
        } else if (selected_index === 7) { // Back
                settings_menu();
        }
        if (selected_index !== 7) {
                gt_buffer_flush();
        }
}

function settings_ui_menu() {
        write_title_index('UI');
        write_index(0, 'Parameter 1', 0);
        write_index(1, 'Parameter 2', 0);
        write_index(2, 'Parameter 3', 4);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'ui', false);
}

function settings_ui_update(selected_index) {
        if (selected_index === 7) { // Back
                settings_menu();
        }
        if (selected_index !== 7) {
                gt_buffer_flush();
        }
}

function disable_radio() {
        bus.data.send({
                src : 'GT',
                dst : 'RAD',
                msg : [ 0x45, 0x02 ],
        });
}

function enable_radio() {
        bus.data.send({
                src : 'GT',
                dst : 'RAD',
                msg : [ 0x45, 0x00 ],
        });
}

function main_menu() {
        write_title_index('Main Menu');
        write_index(0, 'Dashboard', 0);
        write_index(1, 'Device Selection', 0);
        write_index(2, 'Settings', 4);
        gt_buffer_flush();
        update.status('gt.menu', 'main', false);
}

function device_selection_menu() {
        write_title_index('Devices');
        write_index(0, 'Pairing', 0);
        write_index(1, 'Clear Pairings', 0);
        const device_name = '23 char long dev name *';
        write_index(2, device_name, 4);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'device_selection', false);
}

function settings_menu() {
        write_title_index('Settings');
        write_index(0, 'About', 0);
        write_index(1, 'Audio', 0);
        write_index(2, 'Calls', 0);
        write_index(3, 'Comfort', 0);
        write_index(4, 'UI', 2);
        write_index(7, 'Back', 0);
        gt_buffer_flush();
        update.status('gt.menu', 'settings', false);
}

function gt_buffer_flush() {
        gt_update(status.gt.nav_type_index);
}

function write_zone(index, text) {
        // Send message
        bus.data.send({
                src : 'RAD',
                dst : 'GT',
                msg : [ 0xA5, 0x62, 0x01, index ].concat(text),
        });
        update.status('gt.nav_type_index', 0x62, false);
        gt_buffer_flush();
}

function write_index(index, text, clearIdxs) {
        let stringLength = text.length;
        let newTextLength = stringLength + clearIdxs + 1;
        let newText = new Array(newTextLength + 1).fill(0x20); // Fill with spaces (0x20)

        // Copy the original text into newText
        for (let i = 0; i < stringLength; i++) {
                newText[i] = text.charCodeAt(i); // Copy each character as its ASCII value
        }

        stringLength = newTextLength - (clearIdxs + 1);
        while (stringLength < newTextLength) {
                newText[stringLength] = 0x06; // Fill with 0x06
                stringLength++;
        }

        newText[newTextLength] = 0;
        update.status('gt.nav_index_type', 0x61, false);
        // Send message
        bus.data.send({
                src : 'RAD',
                dst : 'GT',
                msg : [ 0x21, 0x61, 0x00, index + 0x40 ].concat(newText),
        });
}

function write_title_index(text) {
	let stringLength = text.length;
	if (stringLength > 24) {
		stringLength = 24;
	}
        let newTextLength = stringLength + 1;
        let newText = new Array(newTextLength + 1).fill(0x06);

        // Copy the original text into newText
        for (let i = 0; i < stringLength; i++) {
                newText[i] = text.charCodeAt(i); // Copy each character as its ASCII value
        }
        // Send message
        bus.data.send({
                src : 'RAD',
                dst : 'GT',
                msg : [ 0x21, 0x61, 0x00, 0x09 ].concat(newText),
        });
}

function gt_update(update_type) {
        bus.data.send({
                src : 'RAD',
                dst : 'GT',
                msg : [ 0xA5, update_type, 0x01, 0x00 ],
        });
}

function switch_screen_off() {
        bus.data.send({
                src : 'GT',
                dst : 'BMBT',
                msg : [ 0x4F, 0x00 ],
        });
}

function switch_screen_on() {
        bus.data.send({
                src : 'GT',
                dst : 'BMBT',
                msg : [ 0x4F, 0x10 ],
        });
}

function change_ui_req(data) {
        if (data.msg[1] === 0x02 && data.msg[2] === 0x0C) {
                bus.data.send({ // Display Menu
                        src : 'TEL',
                        dst : 'GT',
                        msg : [ 0x21, 0x42, 0x02, 0x20 ],
                });
                bus.data.send({ // Display Number
                        src : 'TEL',
                        dst : 'GT',
                        msg : [ 0x23, 0x61, 0x20 ],
                });
        }
}

function screen_mode_set(data) {
        if (data.msg[1] === 0x10) { // Nav Boot
                update.status('gt.menu', 'none', false);
                //update.status('', '', false);
        }
}

// Parse data sent from GT module
function parse_out(data) {
	switch (data.msg[0]) {
		// Broadcast: Indicator status
		case 0x2B : {
			data.command = 'bro';
			data.value   = 'TODO: indicator status';
			break;
		}

		// Change UI Req
		case 0x20 : return change_ui_req(data);

		// Select Menu
		case 0x31 : return select_menu(data);

		// Screen Mode set
		case 0x45 : return screen_mode_set(data);

		// Control: DSP
		case 0x34 : return parse_control_dsp(data);

		// Control: Select menu
		case 0x37 : {
			data.command = 'con';
			data.value   = 'TODO: select menu 0x' + data.msg[1].toString(16);
			break;
		}

		// Control: Set time/date
		// TODO: Parsing
		case 0x40 : {
			data.command = 'con';
			data.value   = 'Set time/date';
			console.dir({ msg : data.msg });
			break;
		}

		// Request: On-board computer data
		// 00    --- OBC_Mode_00
		// 01 01 --- Time current value request
		// 01    --- Time
		// 02 01 --- Date current value request
		// 02    --- Date
		// 03 01 --- Outside_Temp current value request
		// 03    --- Outside_Temp
		// 04 01 --- Consumption_1 current value request
		// 04    --- Consumption_1
		// 05 01 --- Consumption_2 current value request
		// 06 01 --- Range current value request
		// 07 01 --- Distance current value request
		// 08 01 --- Arrival current value request
		// 09 01 --- Limit current value request
		// 09 02 --- Limit status request
		// 0A 01 --- Average_Speed current value request
		// 0D 02 --- Code status request
		// 0E 01 --- Stopwatch current value request
		// 0E 03 --- Stopwatch current value request status request
		// 0F 01 --- Timer_1 current value request
		// 10 01 --- Timer_2 current value request
		// 10    --- Timer_2
		// 11    --- Aux_Heating_Off
		// 12    --- Aux_Heating_On
		// 13    --- Aux_Vent_Off
		// 14    --- Aux_Vent_On
		// 15    --- End_Stellmode
		// 16    --- Emergency_Disarm
		// 17    --- OBC_Mode_17
		// 18    --- OBC_Mode_18
		// 1A 01 --- Interim_Time current value request
		// 1B 03 --- Aux_Heat/Vent current value request status request
		case 0x41 : {
			data.command = 'con';

			switch (data.msg[1]) {
				case 0x00: data.value = 'OBC mode 0';           break;
				case 0x01: data.value = 'Time';                 break;
				case 0x02: data.value = 'Date';                 break;
				case 0x03: data.value = 'Outside temp';         break;
				case 0x04: data.value = 'Consumption 1';        break;
				case 0x05: data.value = 'Consumption 2';        break;
				case 0x06: data.value = 'Range';                break;
				case 0x07: data.value = 'Distance';             break;
				case 0x08: data.value = 'Arrival';              break;
				case 0x09: data.value = 'Speed limit';          break;
				case 0x0A: data.value = 'Average speed';        break;
				case 0x0D: data.value = 'Code';                 break;
				case 0x0E: data.value = 'Stopwatch';            break;
				case 0x0F: data.value = 'Timer 1';              break;
				case 0x10: data.value = 'Timer 2';              break;
				case 0x11: data.value = 'Aux heat off';         break;
				case 0x12: data.value = 'Aux heat on';          break;
				case 0x13: data.value = 'Aux vent off';         break;
				case 0x14: data.value = 'Aux vent on';          break;
				case 0x15: data.value = 'End adjustment mode';  break;
				case 0x16: data.value = 'Emergency disarm';     break;
				case 0x17: data.value = 'OBC mode 17';          break;
				case 0x18: data.value = 'OBC mode 18';          break;
				case 0x1A: data.value = 'Interim time';         break;
				case 0x1B: data.value = 'Aux heat/vent status'; break;

				default: data.value = `Unknown ${hex.i2s(data.msg[1])}`;
			}

			break;
		}

		// Control: Cassette
		case 0x4A : {
			BMBT.cassette_status(data.msg[1]);

			data.command = 'con';
			data.value   = 'cassette: ';

			switch (data.msg[1]) {
				case 0x00 : data.value += 'power off'; break;
				case 0xFF : data.value += 'power on';  break;
				default   : data.value += 'unknown 0x' + data.msg[1].toString(16);
			}
			break;
		}

		// Control: Audio source selection
		case 0x4E : {
			data.command = 'con';
			data.value   = 'TODO: audio source selection ' + hex.i2s(data.msg[1]) + ' ' + hex.i2s(data.msg[2]);
			break;
		}

		// Control: LCD (screen in dash)
		case 0x4F : return parse_control_lcd(data);

		// Control: DSP EQ delta update
		case 0x95 : {
			data.command = 'con';
			data.value   = 'TODO: DSP EQ delta update';
			break;
		}
	}

	return data;
}

function init_listeners() {
	update.on('status.bluetooth.device.connected', () => {
		main_menu();
	});
        update.status('gt.nav_index_type', 0x61, false);
	log.module('Initialized listeners');
}

module.exports = {
        init_listeners,

	parse_out,
};
